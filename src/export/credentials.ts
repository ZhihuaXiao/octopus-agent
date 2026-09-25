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
 * Three places are read, all of them the ones pi itself resolves a key from:
 * the environment, for variables whose names say they hold a key, token,
 * secret, password or credential; pi's `auth.json`, for each provider's API
 * key or OAuth tokens and the environment a credential carries; and pi's
 * `models.json`, for the API keys and header values a custom provider is
 * configured with. A value in either file written `$NAME` or `${NAME}` stands
 * for the variable it names, looked up as pi looks it up — in the credential's
 * own environment first, then the process's — which reads one named variable
 * and runs nothing. One written `!command` is a command pi runs to find the
 * key, which an Export has no business running; the credential it would
 * produce is in no file, and stays out of the document only by never having
 * been printed.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { isRecord } from "../util/guards.js";

/** An environment: variables by name, as the process has them. */
type Environment = Readonly<Record<string, string | undefined>>;

export interface CredentialSources {
  /** The environment as the process has it. */
  readonly environment: Environment;
  /** Pi's agent directory, where `auth.json` and `models.json` are kept. */
  readonly agentDirectory: string;
}

/** Where this machine's credentials are: this process's environment, and the agent directory pi uses. */
export const thisMachine = (): CredentialSources => ({
  environment: process.env,
  agentDirectory: getAgentDir(),
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
  "CREDENTIAL",
  "CREDENTIALS",
]);

/**
 * The shortest value worth striking out. Anything shorter would be found
 * inside ordinary words, and a credential that short is not one.
 */
const SHORTEST_CREDENTIAL = 8;

const namesSecret = (name: string) =>
  name
    .toUpperCase()
    .split("_")
    .some((word) => SECRET_WORDS.has(word));

/** The values of the variables whose names say they hold a credential. */
const secretsOf = (environment: Environment) =>
  Object.entries(environment).flatMap(([name, value]) =>
    value !== undefined && namesSecret(name) ? [value] : [],
  );

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
export async function credentialsHeld(sources: CredentialSources): Promise<string[]> {
  const { environment, agentDirectory } = sources;
  const values = [
    ...secretsOf(environment),
    ...fromAuth(await readJson(join(agentDirectory, "auth.json")), environment),
    ...fromModels(await readJson(join(agentDirectory, "models.json")), environment),
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

/**
 * Whether bytes that are not text hold a credential as it would be written,
 * in UTF-8. Only as written: a credential inside a compressed file is not
 * seen.
 */
export const holdsCredential = (bytes: Buffer, credentials: readonly string[]): boolean =>
  credentials.some((credential) => bytes.includes(Buffer.from(credential, "utf8")));
