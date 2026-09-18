/**
 * The one password, and where it is kept. Stored as a hash the password
 * cannot be read back from, made with scrypt — memory-hard, so that guessing
 * at the hash costs a machine's memory as well as its time, and Node's own,
 * where argon2 would be a native dependency or a Node newer than the one this
 * runs on. The stored line says which function and what parameters made it,
 * so they can change without every stored password going stale at once.
 *
 * The file is the operator's, not a project's: there is one account
 * (ADR-0006), so there is one password, under the user's home directory and
 * readable by nobody else.
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FUNCTION = "scrypt";
/**
 * The cost as OWASP puts it for scrypt: N = 2^17, r = 8, p = 1 — about 128 MiB
 * and a few hundred milliseconds per hash, which presenting the password
 * can spend and a guess must.
 */
const COST = 2 ** 17;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** Only the owner reads or writes the file. */
const OWNER_ONLY = 0o600;

/** Hashes the password, salted, into the line that is stored. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptOf(password, salt, COST, BLOCK_SIZE, PARALLELISM);
  return [FUNCTION, COST, BLOCK_SIZE, PARALLELISM, base64url(salt), base64url(hash)].join("$");
}

/** Whether the password is the one the stored line was made from; false for a line that cannot be read. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [name, cost, blockSize, parallelism, salt, hash, ...rest] = stored.split("$");
  if (name !== FUNCTION || salt === undefined || hash === undefined || rest.length > 0) {
    return false;
  }
  const parameters = [cost, blockSize, parallelism].map((text) =>
    /^\d+$/.test(text ?? "") ? Number(text) : NaN,
  ) as [number, number, number];
  if (!parameters.every((parameter) => parameter > 0)) return false;
  const expected = Buffer.from(hash, "base64url");
  if (expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = await scryptOf(password, Buffer.from(salt, "base64url"), ...parameters);
  } catch {
    return false; // Parameters no scrypt would take.
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function scryptOf(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelism: number,
): Promise<Buffer> {
  return new Promise((derived, failed) => {
    scrypt(
      password,
      salt,
      HASH_BYTES,
      // Node allows 32 MiB unless told otherwise; the cost above wants four times that.
      { N: cost, r: blockSize, p: parallelism, maxmem: 128 * cost * blockSize * 2 },
      (cause, key) => (cause ? failed(cause) : derived(key)),
    );
  });
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** Where the password is kept: under the user's home directory, beside nothing of any project's. */
export const passwordFile = (): string => join(homedir(), ".octo", "password");

/** The stored line, or nothing when no password has been set. */
export async function readStoredPassword(file = passwordFile()): Promise<string | undefined> {
  try {
    const stored = (await readFile(file, "utf8")).trim();
    return stored === "" ? undefined : stored;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

/** Sets the password, replacing the one before, in a file only its owner can read. */
export async function storePassword(password: string, file = passwordFile()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${await hashPassword(password)}\n`, {
    encoding: "utf8",
    mode: OWNER_ONLY,
  });
  // `mode` applies only when the file is made; one already there keeps what it had.
  await chmod(file, OWNER_ONLY);
}
