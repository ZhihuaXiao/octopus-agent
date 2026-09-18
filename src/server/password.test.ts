import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hashPassword, readStoredPassword, storePassword, verifyPassword } from "./password.js";

describe("hashing the password", () => {
  it("stores what the password cannot be read back from, and says how it was made", async () => {
    const stored = await hashPassword("correct horse battery staple");

    expect(stored).not.toContain("correct horse");
    expect(stored).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  });

  it("verifies the password it was made from, and no other", async () => {
    const stored = await hashPassword("correct horse battery staple");

    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stable", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts each hash, so the same password stored twice reads differently", async () => {
    const [one, other] = await Promise.all([hashPassword("secret"), hashPassword("secret")]);

    expect(one).not.toBe(other);
    expect(await verifyPassword("secret", other)).toBe(true);
  });

  it("verifies nothing against a stored value it cannot read", async () => {
    expect(await verifyPassword("secret", "")).toBe(false);
    expect(await verifyPassword("secret", "plain:secret")).toBe(false);
    expect(await verifyPassword("secret", "scrypt$abc$8$1$salt$hash")).toBe(false);
  });
});

describe("the stored password", () => {
  const home = () => mkdtemp(join(tmpdir(), "octo-password-"));

  it("is nothing until one is set", async () => {
    const file = join(await home(), "password");

    expect(await readStoredPassword(file)).toBeUndefined();
  });

  it("is written where only its owner can read it, and read back as stored", async () => {
    const file = join(await home(), "octo", "password");

    await storePassword("secret", file);

    const stored = await readStoredPassword(file);
    expect(stored).toBeDefined();
    expect(await verifyPassword("secret", stored ?? "")).toBe(true);
    expect((await readFile(file, "utf8")).trim()).toBe(stored);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("is replaced by the next one set", async () => {
    const file = join(await home(), "password");
    await storePassword("first", file);

    await storePassword("second", file);

    const stored = (await readStoredPassword(file)) ?? "";
    expect(await verifyPassword("first", stored)).toBe(false);
    expect(await verifyPassword("second", stored)).toBe(true);
  });
});
