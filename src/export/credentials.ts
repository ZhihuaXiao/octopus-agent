/**
 * The credentials the machine holds, so an Export can be sure none is in it.
 *
 * A Notebook names providers and never credentials (spec, Security), and a Run
 * Record is built from what the Cells said and did — but a Bash Cell inherits
 * the environment and can print any of it, and an agent asked to debug its
 * setup will happily `cat ~/.pi/agent/auth.json`. So "the export contains no
 * credentials" cannot be had by construction alone; the values the machine
 * holds have to be known, and struck out wherever an output repeats one.
 *
 * The values are read from the environment, from pi's `auth.json` and
 * `models.json`, and from the credential files a shell on this machine would
 * find under the home directory. A variable whose name says it holds a key,
 * token, secret, password, or credential is taken whole. One whose name says
 * it is a URL, URI, or DSN contributes the password inside it, not the
 * address. A value in pi's files written `$NAME` or `${NAME}` stands for the
 * variable it names, looked up as pi looks it up — in the credential's own
 * environment first, then the process's — which reads one named variable and
 * runs nothing. One written `!command` is a command pi runs to find the key,
 * which an Export has no business running; the credential it would produce
 * is in no file, and stays out of the document only by never having been
 * printed.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { isRecord } from "../util/guards.js";

/** An environment: variables by name, as the process has them. */
type Environment = Readonly<Record<string, string | undefined>>;

export interface CredentialSources {
  /** The environment as the process has it. */
  readonly environment: Environment;
  /** Pi's agent directory, where `auth.json` and `models.json` are kept. */
  readonly agentDirectory: string;
  /**
   * The home directory whose credential files are read. Absent reads none,
   * which is how a test keeps the machine it runs on out of the document.
   */
  readonly home?: string;
}

/** Where this machine's credentials are: this process's environment, the agent directory pi uses, and the home directory. */
export const thisMachine = (): CredentialSources => ({
  environment: process.env,
  agentDirectory: getAgentDir(),
  home: homedir(),
});

/**
 * The words in a variable's name that say it holds a credential, matched as
 * whole segments between underscores: `ANTHROPIC_API_KEY`, `HF_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY`, `DB_PASSWORD`, `AWS_BEARER_TOKEN_BEDROCK`.
 */
const SECRET_WORDS = new Set([
  "KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PWD",
  "CREDENTIAL",
  "CREDENTIALS",
]);

/** A variable whose value is an address that may carry a password, not a secret of its own. */
const ADDRESS_WORDS = new Set(["URL", "URI", "DSN"]);

/**
 * The shortest value worth striking out. Anything shorter would be found
 * inside ordinary words, and a credential that short is not one.
 */
const SHORTEST_CREDENTIAL = 8;

const wordsOf = (name: string) =>
  name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((word) => word !== "");

/**
 * Whether `name` says the value is a credential. A segment between
 * separators counts (`MYSQL_PWD`, `AWS_SECRET_ACCESS_KEY`), and so does a
 * name that ends in one of those words with no separator (`PGPASSWORD`).
 */
const namesSecret = (name: string) => {
  const words = wordsOf(name);
  if (words.some((word) => SECRET_WORDS.has(word))) return true;
  const joined = words.join("");
  return [...SECRET_WORDS].some((word) => joined.endsWith(word) && joined.length > word.length);
};

const namesAddress = (name: string) => wordsOf(name).some((word) => ADDRESS_WORDS.has(word));

/** The password a URL carries in its userinfo or in a query, when it has one long enough to be a credential. */
function passwordsInUrl(value: string): string[] {
  const found: string[] = [];
  const raw = /:\/\/[^/?#\s:@]*:([^@/?#\s]+)@/.exec(value);
  if (raw?.[1] !== undefined && raw[1].length >= SHORTEST_CREDENTIAL) found.push(raw[1]);
  try {
    const url = new URL(value);
    if (url.password.length >= SHORTEST_CREDENTIAL) found.push(url.password);
    for (const key of ["password", "pwd", "token", "secret", "access_token"]) {
      const item = url.searchParams.get(key);
      if (item !== null && item.length >= SHORTEST_CREDENTIAL) found.push(item);
    }
  } catch {
    // Not a URL. The userinfo expression above is the whole of what can be read.
  }
  return found;
}

/** The values of the variables whose names say they hold a credential, and the passwords inside address variables. */
const secretsOf = (environment: Environment) =>
  Object.entries(environment).flatMap(([name, value]) => {
    if (value === undefined || value === "") return [];
    if (namesSecret(name)) return [value];
    return namesAddress(name) ? passwordsInUrl(value) : [];
  });

/** A `$NAME` or `${NAME}` in a value pi is configured with, as pi's own resolver reads one. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The credentials a configured value stands for: the value itself when it is
 * written out, the variables it names when it refers to any, and nothing for
 * a `!command`, which is not run.
 */
function credentialsIn(value: unknown, environment: Environment): string[] {
  if (typeof value !== "string" || value.startsWith("!")) return [];
  const references = [...value.matchAll(REFERENCE)];
  if (references.length === 0) return [value];
  return references.flatMap((reference) => {
    const named = environment[reference[1] ?? reference[2] ?? ""];
    return named === undefined ? [] : [named];
  });
}

/** A JSON file's value, or nothing when there is no file or it is not JSON — either is a machine with nothing there. */
async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** The string-valued variables of an environment pi's config gives a credential. */
function environmentOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

/**
 * What pi's `auth.json` holds: one credential per provider — an API key or an
 * OAuth pair — and the environment it may carry, which its key is resolved in
 * before the process's.
 */
function fromAuth(auth: unknown, environment: Environment): string[] {
  if (!isRecord(auth)) return [];
  const found: string[] = [];
  for (const credential of Object.values(auth)) {
    if (!isRecord(credential)) continue;
    const carried = environmentOf(credential.env);
    const resolvedIn = { ...environment, ...carried };
    for (const field of ["key", "access", "refresh"]) {
      found.push(...credentialsIn(credential[field], resolvedIn));
    }
    found.push(...secretsOf(carried));
  }
  return found;
}

/** The header values a provider or a model is configured with. */
function fromHeaders(headers: unknown, environment: Environment): string[] {
  return isRecord(headers)
    ? Object.values(headers).flatMap((value) => credentialsIn(value, environment))
    : [];
}

/** What pi's `models.json` holds: a custom provider's API key, and the headers it and its models send. */
function fromModels(models: unknown, environment: Environment): string[] {
  if (!isRecord(models) || !isRecord(models.providers)) return [];
  const found: string[] = [];
  for (const provider of Object.values(models.providers)) {
    if (!isRecord(provider)) continue;
    found.push(...credentialsIn(provider.apiKey, environment));
    found.push(...fromHeaders(provider.headers, environment));
    if (Array.isArray(provider.models)) {
      for (const model of provider.models) {
        if (isRecord(model)) found.push(...fromHeaders(model.headers, environment));
      }
    }
  }
  return found;
}

/**
 * Every credential value the machine holds, each once and the longest first,
 * so that striking them out in order can never leave the tail of a longer
 * one behind. Values too short to be a credential are left out.
 */
/**
 * Credential files a shell on this machine would find, relative to home.
 * Read and not executed. A file that is missing is a machine that has none.
 */
const CREDENTIAL_FILES: readonly (readonly string[])[] = [
  [".aws", "credentials"],
  [".netrc"],
  [".npmrc"],
  [".config", "gh", "hosts.yml"],
  [".kube", "config"],
  [".ssh", "id_rsa"],
  [".ssh", "id_ed25519"],
  [".ssh", "id_ecdsa"],
];

/** As much of one credential file as is worth reading. A larger one is not a key file. */
const LONGEST_CREDENTIAL_FILE = 1024 * 1024;

/** A text file, or nothing when it is missing, not a file, or too large. */
async function readLimited(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > LONGEST_CREDENTIAL_FILE) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether an assigned name, or its last path segment, says the value is a credential. */
function keyIsSecret(key: string): boolean {
  const trimmed = key.trim().replace(/^['"]|['"]$/g, "");
  if (namesSecret(trimmed)) return true;
  const tail = trimmed.split(/[/:]/).findLast((part) => part !== "");
  return tail !== undefined && namesSecret(tail);
}

/**
 * Credentials written into a file: assignments whose names say so, a netrc
 * `password` line, and a private key both as the block that was written and
 * as the body with its line breaks removed.
 */
function secretsInText(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    // `=` before `:`. An npmrc key contains a colon (`//host/:_authToken=…`)
    // and the separator is the equals sign.
    const separator = trimmed.includes("=") ? "=" : ":";
    const at = trimmed.indexOf(separator);
    const assigned = at === -1 ? undefined : [trimmed.slice(0, at), trimmed.slice(at + 1)];
    if (assigned !== undefined && keyIsSecret(assigned[0] ?? "")) {
      const value = (assigned[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
      if (value.length >= SHORTEST_CREDENTIAL && !value.startsWith("!")) found.push(value);
    }
    const netrc = /\b(?:password|passwd)\s+(\S+)/i.exec(trimmed);
    if (netrc?.[1] !== undefined && netrc[1].length >= SHORTEST_CREDENTIAL) found.push(netrc[1]);
  }
  for (const match of text.matchAll(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  )) {
    const pem = match[0];
    if (pem.length >= SHORTEST_CREDENTIAL) found.push(pem);
    const body = pem
      .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "")
      .replace(/-----END [A-Z0-9 ]*PRIVATE KEY-----/, "")
      .replace(/\s+/g, "");
    if (body.length >= SHORTEST_CREDENTIAL) found.push(body);
  }
  return found;
}

/** Credentials in the files under `home`, or nothing when no home was named. */
async function fromHome(home: string | undefined): Promise<string[]> {
  if (home === undefined) return [];
  const found: string[] = [];
  for (const parts of CREDENTIAL_FILES) {
    const text = await readLimited(join(home, ...parts));
    if (text !== undefined) found.push(...secretsInText(text));
  }
  return found;
}

export async function credentialsHeld(sources: CredentialSources): Promise<string[]> {
  const { environment, agentDirectory, home } = sources;
  const values = [
    ...secretsOf(environment),
    ...fromAuth(await readJson(join(agentDirectory, "auth.json")), environment),
    ...fromModels(await readJson(join(agentDirectory, "models.json")), environment),
    ...(await fromHome(home)),
  ];
  return [...new Set(values.filter((value) => value.length >= SHORTEST_CREDENTIAL))].sort(
    (a, b) => b.length - a.length,
  );
}

/** What stands where a credential was. */
export const REDACTED = "[redacted]";

/**
 * Strikes every one of `credentials` out of a text, longest first. Given none,
 * the text as it was.
 */
export function redactor(credentials: readonly string[]): (text: string) => string {
  if (credentials.length === 0) return (text) => text;
  return (text) => {
    let redacted = text;
    for (const credential of credentials) redacted = redacted.replaceAll(credential, REDACTED);
    return redacted;
  };
}

/** As much uncompressed content as a scan will look through. More than that is withheld. */
const SCAN_LIMIT = 8 * 1024 * 1024;

const contains = (bytes: Buffer, credentials: readonly string[]) =>
  credentials.some(
    (credential) => credential.length > 0 && bytes.includes(Buffer.from(credential)),
  );

/**
 * The files inside a zip, uncompressed, or nothing when the archive cannot be
 * read. An unreadable archive is withheld: a credential inside it would not
 * be seen.
 */
function zipEntries(bytes: Buffer): Buffer[] | undefined {
  const found: Buffer[] = [];
  let offset = 0;
  let total = 0;
  while (offset + 30 <= bytes.length) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
    const method = bytes.readUInt16LE(offset + 8);
    const compressed = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extraLength;
    const end = start + compressed;
    if (end > bytes.length) return undefined;
    const data = bytes.subarray(start, end);
    let plain: Buffer;
    if (method === 0) plain = Buffer.from(data);
    else if (method === 8) {
      try {
        plain = inflateRawSync(data, { maxOutputLength: SCAN_LIMIT });
      } catch {
        return undefined;
      }
    } else return undefined;
    total += plain.length;
    if (total > SCAN_LIMIT) return undefined;
    found.push(plain);
    offset = end;
  }
  return offset === 0 ? undefined : found;
}

/**
 * Whether bytes hold a credential as it would be written, in UTF-8. A gzip
 * or zip is looked inside, up to a limit. One that cannot be read is treated
 * as holding one, so it is withheld rather than embedded unseen.
 */
export function holdsCredential(bytes: Buffer, credentials: readonly string[]): boolean {
  if (credentials.length === 0) return false;
  if (contains(bytes, credentials)) return true;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return contains(gunzipSync(bytes, { maxOutputLength: SCAN_LIMIT }), credentials);
    } catch {
      return true;
    }
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    const entries = zipEntries(bytes);
    if (entries === undefined) return true;
    return entries.some((entry) => contains(entry, credentials));
  }
  return false;
}
