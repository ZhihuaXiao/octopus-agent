/**
 * `npm run octo` written without its `--`. npm takes every option before a
 * `--` as one of its own, so `npm run octo --web --host 0.0.0.0` never hands
 * octo the flags: they arrive in the environment as `npm_config_web` and
 * `npm_config_host`, and a value written as the next word is left behind as
 * an argument while its option reads `"true"`. What octo is handed is then
 * `0.0.0.0` alone, which is pi's to make sense of, and no server starts.
 *
 * Only the web interface's flags are put back. The Inputs of a `run` could
 * be any name at all, and so could pi's flags, and nothing in the
 * environment says which of the `npm_config_` names came from this command
 * line; the web flags are four names npm has no use for, bar `--password`.
 */

/** The environment names npm gives the web flags, which the process's children must not inherit. */
export const NPM_WEB_CONFIG = {
  web: "npm_config_web",
  password: "npm_config_password",
  host: "npm_config_host",
  port: "npm_config_port",
  access: "npm_config_cell_access",
} as const;

/** What npm sets an option to when it was given without an attached value. */
const GIVEN = "true";

const isPortShaped = (word: string) => /^\d+$/.test(word);

/**
 * The command line octo was meant to be given, from what npm handed it and
 * what npm put in the environment. Unchanged unless one of the web flags
 * reached npm rather than octo.
 */
export function fromNpm(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const web = env[NPM_WEB_CONFIG.web];
  const host = env[NPM_WEB_CONFIG.host];
  const port = env[NPM_WEB_CONFIG.port];
  // `--password` is npm's own, and takes a value: `--password --port=9000`
  // leaves npm holding the next option as the password. Anything else there
  // is a registry password from npm's configuration, and none of octo's.
  const password = env[NPM_WEB_CONFIG.password];
  const passwordGiven = password === GIVEN || password?.startsWith("--") === true;
  const access = env[NPM_WEB_CONFIG.access];

  if (web !== GIVEN && host === undefined && port === undefined && !passwordGiven) return argv;

  const rest = [...argv];
  const recovered: string[] = [];
  if (web === GIVEN) recovered.push("--web");
  if (passwordGiven) {
    recovered.push("--password");
    if (password !== GIVEN) recovered.push(password ?? "");
  }

  // A value written as the next word is left among the arguments, in the
  // order the options were written — an order the environment does not keep.
  // With both left there, the port is the one that looks like a port.
  const leftFor = (given: string | undefined) =>
    given === GIVEN && rest[0] !== undefined && !rest[0].startsWith("-") ? rest.shift() : undefined;
  let hostValue = host === GIVEN ? undefined : host;
  let portValue = port === GIVEN ? undefined : port;
  if (host === GIVEN && port === GIVEN) {
    const first = leftFor(host);
    const second = leftFor(port);
    const swapped = first !== undefined && isPortShaped(first) && !isPortShaped(second ?? "");
    hostValue = swapped ? second : first;
    portValue = swapped ? first : second;
  } else {
    hostValue ??= leftFor(host);
    portValue ??= leftFor(port);
  }

  if (access !== undefined && access !== "") recovered.push("--cell-access", access);
  if (host !== undefined) recovered.push("--host", ...(hostValue !== undefined ? [hostValue] : []));
  if (port !== undefined) recovered.push("--port", ...(portValue !== undefined ? [portValue] : []));
  return [...recovered, ...rest];
}
