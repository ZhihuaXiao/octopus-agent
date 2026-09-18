/**
 * Who may speak to the server. There is one account (ADR-0006), and it is
 * proved one of two ways: by the token generated when the server started —
 * printed once, in the URL to open, and known to nobody else — or by the
 * password the operator stored. Proving it opens a Connection: an id the
 * server holds until it stops and the browser carries as a cookie, so that
 * the token leaves the address bar as soon as it has been used and the
 * password travels once. A script presents the token as a bearer instead,
 * with each request, and opens nothing.
 *
 * A wrong password is a guess, and guesses are made to wait: each failure
 * in a row doubles the time before the next attempt is looked at, so a
 * password cannot be tried at the rate the network allows. A wrong token
 * is simply refused — 256 bits cannot be guessed at, and treating one as
 * a guess would make a stale bookmark hold up the URL this start printed.
 * Attempts are looked at one at a time, since hashing a password takes a
 * while and a burst fired inside that while would otherwise all be looked
 * at before the first had failed. A cookie the server does not know is
 * not a guess — it is a browser from before a restart — and costs nothing.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import { verifyPassword } from "./password.js";

/** What a client presents: the token, or the password. */
export type Credential =
  | { readonly kind: "token"; readonly value: string }
  | { readonly kind: "password"; readonly value: string };

/** What became of a credential presented: taken, found wrong, or not looked at. */
export type Attempt =
  | { readonly kind: "accepted" }
  | { readonly kind: "refused" }
  /** Refused unlooked at: too soon after a failure. How long to wait, in whole seconds. */
  | { readonly kind: "wait"; readonly seconds: number };

export interface AuthOptions {
  /**
   * The password as `password.ts` stored it — its hash, never the password —
   * when that is what the account authenticates with; absent, a token is
   * generated instead.
   */
  readonly storedPassword?: string;
}

export interface Auth {
  /** Which credential this server takes, so a refusal can say what to present. */
  readonly method: Credential["kind"];
  /** The token, when that is what the server takes. */
  readonly token?: string;
  /** Checks a credential, counting a wrong one as the guess it is. */
  attempt(credential: Credential): Promise<Attempt>;
  /** Opens a Connection, and returns the id the browser is to carry. */
  connect(): string;
  /** Whether a Connection id is one this server opened. */
  connected(id: string): boolean;
}

/** Bytes of a token or a Connection id: 256 bits, which is beyond guessing. */
const SECRET_BYTES = 32;
/** The wait after the first failure in a row, doubling with each after it, up to the longest. */
const FIRST_WAIT = 1000;
const LONGEST_WAIT = 60_000;

const secret = () => randomBytes(SECRET_BYTES).toString("hex");

/** Whether two strings are the same, in time that says nothing about where they differ. */
function same(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAuth(options: AuthOptions = {}): Auth {
  const { storedPassword } = options;
  const token = storedPassword === undefined ? secret() : undefined;
  const connections = new Set<string>();
  /** Failures in a row, and the moment before which no attempt is looked at. */
  let failures = 0;
  let allowedAt = 0;
  /** The attempt being looked at, which the next waits behind. */
  let looking: Promise<unknown> = Promise.resolve();

  /** Whether the credential is the one this server takes: the right kind, and right. */
  const verify = async (credential: Credential): Promise<boolean> => {
    if (credential.kind === "token") return token !== undefined && same(credential.value, token);
    return storedPassword !== undefined && (await verifyPassword(credential.value, storedPassword));
  };

  const lookAt = async (credential: Credential): Promise<Attempt> => {
    const moment = Date.now();
    if (moment < allowedAt) {
      return { kind: "wait", seconds: Math.ceil((allowedAt - moment) / 1000) };
    }
    if (await verify(credential)) {
      failures = 0;
      return { kind: "accepted" };
    }
    // Only a password is a guess worth making wait. A wrong token is refused
    // and forgotten, so a stale URL cannot hold up the one this start printed.
    if (credential.kind === "password") {
      failures += 1;
      // From now, not from `moment`: hashing a password takes a while of its own.
      allowedAt = Date.now() + Math.min(FIRST_WAIT * 2 ** (failures - 1), LONGEST_WAIT);
    }
    return { kind: "refused" };
  };

  return {
    method: token === undefined ? "password" : "token",
    ...(token !== undefined ? { token } : {}),
    attempt(credential) {
      // Behind whatever is being looked at now, however that turns out.
      const turn = looking.then(
        () => lookAt(credential),
        () => lookAt(credential),
      );
      looking = turn;
      return turn;
    },
    connect() {
      const id = secret();
      connections.add(id);
      return id;
    },
    connected: (id) => connections.has(id),
  };
}
