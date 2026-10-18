import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { credentialsHeld, holdsCredential, redactor } from "./credentials.js";

let dir: string;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

/** A zip local header and stored or deflated bytes. The central directory is not required to scan it. */
function zip(name: string, data: Buffer, method: 0 | 8): Buffer {
  const fileName = Buffer.from(name);
  const payload = method === 0 ? data : deflateRawSync(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(payload.length, 18);
  header.writeUInt16LE(fileName.length, 26);
  return Buffer.concat([header, fileName, payload]);
}

describe("credentialsHeld", () => {
  it("redacts a password variable with no separator, and only the password inside an address", async () => {
    const values = await credentialsHeld({
      environment: {
        PGPASSWORD: "pg-secret-value",
        MYSQL_PWD: "mysql-secret-value",
        DATABASE_URL: "postgres://app:db-secret-value@localhost/app",
        PUBLIC_URL: "https://example.com/notes",
      },
      agentDirectory: join(tmpdir(), "octo-credentials-missing"),
    });
    const hide = redactor(values);

    expect(
      hide("pg-secret-value mysql-secret-value db-secret-value https://example.com/notes"),
    ).toBe("[redacted] [redacted] [redacted] https://example.com/notes");
  });

  it("reads a password from the home directory's credential files", async () => {
    dir = await mkdtemp(join(tmpdir(), "octo-credentials-"));
    await mkdir(join(dir, ".aws"));
    await writeFile(
      join(dir, ".aws", "credentials"),
      "[default]\naws_secret_access_key = aws-secret-value\n",
      "utf8",
    );
    await writeFile(
      join(dir, ".netrc"),
      "machine example.com\nlogin me\npassword netrc-secret-value\n",
      "utf8",
    );
    await writeFile(
      join(dir, ".npmrc"),
      "//registry.npmjs.org/:_authToken=npm-secret-value\n",
      "utf8",
    );

    const values = await credentialsHeld({
      environment: {},
      agentDirectory: join(dir, "agent"),
      home: dir,
    });
    const hide = redactor(values);

    expect(hide("aws-secret-value netrc-secret-value npm-secret-value")).toBe(
      "[redacted] [redacted] [redacted]",
    );
  });
});

describe("holdsCredential", () => {
  const secret = "gzip-secret-value";

  it("sees a credential inside gzip and zip, and leaves a compressed file that has none", () => {
    expect(holdsCredential(gzipSync(Buffer.from(`token ${secret}\n`)), [secret])).toBe(true);
    expect(holdsCredential(gzipSync(Buffer.from("plain text only\n")), [secret])).toBe(false);
    expect(holdsCredential(zip("note.txt", Buffer.from(secret), 0), [secret])).toBe(true);
    expect(holdsCredential(zip("note.txt", Buffer.from(secret), 8), [secret])).toBe(true);
    expect(holdsCredential(zip("note.txt", Buffer.from("plain"), 8), [secret])).toBe(false);
  });

  it("withholds a compressed file it cannot read, and does not treat an image as one", () => {
    expect(holdsCredential(Buffer.from([0x1f, 0x8b, 0x00]), [secret])).toBe(true);
    expect(holdsCredential(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), [secret])).toBe(true);
    expect(holdsCredential(Buffer.from([0x89, 0x50, 0x4e, 0x47]), [secret])).toBe(false);
  });
});
