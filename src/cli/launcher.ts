/**
 * The command line: one command with a few behaviours of its own.
 *
 * Invoked bare it is pi — whatever was said is handed to the real `pi`, flags
 * and all, so the terminal experience stays pi's own rather than a copy of it
 * that would drift. A `run` subcommand executes a Notebook headlessly. The web
 * flags start the server. The first word decides which, and only a word that
 * is ours is read here: anything else is pi's to make sense of, since a list
 * of pi's flags kept here would be one more thing to keep in step with a
 * package that ships breaking changes in one release in six.
 *
 * Within our own, a mistake is reported rather than guessed at. A stray
 * argument silently ignored is a run against the wrong values, and a mistyped
 * flag that fell through to pi would start an interactive session where a
 * server was wanted.
 *
 * An Input is written as a long option named after it, `--target docs`, so a
 * run reads as the Notebook's own vocabulary rather than a generic
 * `--input target=docs`. The two names that would collide with the run's own
 * flags, `trust` and `no-trust`, are reserved from Inputs by the parser.
 */

import { TRUST_FLAGS } from "../notebook/inputs.js";
import { isName } from "../notebook/name.js";
import { DEFAULT_PORT } from "../server/server.js";

const USAGE = `usage: octo [pi arguments]...
       octo run <notebook.md> [--trust|--no-trust] [--<input> <value>]...
       octo import <session.jsonl> <notebook.md>
       octo export <notebook.md> <document.html|document.md> [--run <id>]
       octo --web [--port <number>] [--host <address>] [--password]
       octo password

  A bare invocation is pi itself: anything not shown here is handed to the pi
  command as written, and only a request for help stops here instead.
  \`run\` executes a notebook headlessly, giving each declared input its value.
  \`import\` makes a notebook of a chat had with pi at the terminal — a prompt
  cell for each message you sent, a bash cell for each command you ran with
  \`!\` — and a run record of what it did. Pi's session file is read and
  copied, never written; pi keeps them under ~/.pi/agent/sessions.
  \`export\` writes a notebook and the results of one of its runs — the latest,
  or the one \`--run\` names — as one document, to send to someone who will not
  run it. A destination ending in \`.md\` or \`.markdown\` is Markdown. Any other
  name is HTML, with the files the run left embedded in it. The credentials
  this machine holds are struck out of it; the notebook itself is left as it is.
  \`--web\` starts the web interface on loopback, serving the notebooks under
  the current directory, on the port given or ${DEFAULT_PORT}. It prints the URL
  to open, carrying a token generated for this start; with \`--password\` the
  browser asks for the password set with \`octo password\` instead.
  \`--host\` binds to the address given instead of loopback, so that other
  machines can reach the server. Anyone who reaches that port and
  authenticates can run arbitrary code as the user running octo: there is
  one account and no sandbox. To work from another machine, prefer an
  SSH tunnel to the loopback port and leave this flag out; see docs/remote.md.
  \`password\` sets the password, asking for it rather than reading it here.`;

export type Command =
  /** Not ours: hand the arguments to pi as written. */
  | { readonly kind: "pi"; readonly arguments: readonly string[] }
  | {
      readonly kind: "run";
      readonly notebook: string;
      /** Values as written, for the Run to read against the declared types. */
      readonly inputs: Readonly<Record<string, string>>;
      /** Absent when neither flag was given, leaving the decision to what pi has recorded. */
      readonly trust?: boolean;
    }
  | {
      readonly kind: "web";
      /** Absent when no port was named, leaving the choice to the server. */
      readonly port?: number;
      /**
       * The address to bind, when the server is to be reachable from beyond
       * loopback; absent, it binds loopback and nothing else (ADR-0006).
       */
      readonly host?: string;
      /** Whether the stored password is what authenticates, rather than a token generated at startup. */
      readonly password?: true;
    }
  /** Sets the password `--web --password` asks for. */
  | { readonly kind: "password" }
  /** Makes a Notebook of a Chat, given pi's session file, with a Run Record of what it did. */
  | { readonly kind: "import"; readonly session: string; readonly notebook: string }
  /** Writes a Notebook and one of its Runs as a single document. */
  | {
      readonly kind: "export";
      readonly notebook: string;
      /** Where the document is written. */
      readonly document: string;
      /** The Run to export, by id; absent, the latest. */
      readonly run?: string;
    }
  | { readonly kind: "help"; readonly usage: string }
  | { readonly kind: "mistake"; readonly error: string };

const HELP_FLAGS: readonly string[] = ["--help", "-h"];
/** As a first word only: inside `run`, a bare `help` is a Notebook of that name. */
const HELP_WORD = "help";
const RUN_WORD = "run";
const PASSWORD_WORD = "password";
const IMPORT_WORD = "import";
const EXPORT_WORD = "export";
const RUN_FLAG = "--run";
const WEB_FLAG = "--web";
const PORT_FLAG = "--port";
const HOST_FLAG = "--host";
const PASSWORD_FLAG = "--password";

const help: Command = { kind: "help", usage: USAGE };
const mistake = (error: string): Command => ({ kind: "mistake", error: `${error}\n${USAGE}` });

const isOption = (argument: string) => argument.startsWith("-");

/** An option split at its equals sign, when it has one: `--port=80` is `--port` given `80`. */
function splitOption(argument: string): { name: string; attached: string | undefined } {
  const separator = argument.indexOf("=");
  return separator === -1
    ? { name: argument, attached: undefined }
    : { name: argument.slice(0, separator), attached: argument.slice(separator + 1) };
}

/**
 * The value an option was given: attached with an equals sign, else the word
 * after it. Another option where the value should be is a forgotten value
 * rather than a real one; `--name=--value` says it deliberately. A single dash
 * is not an option here, so `--offset -1` is the negative number it looks
 * like rather than a mistake.
 */
function valueOf(attached: string | undefined, next: string | undefined): string | undefined {
  if (attached !== undefined) return attached;
  return next === undefined || next.startsWith("--") ? undefined : next;
}

export function readCommand(argv: readonly string[]): Command {
  const [first, ...rest] = argv;

  if (first === undefined) return { kind: "pi", arguments: [] };
  if (first === HELP_WORD || HELP_FLAGS.includes(first)) return help;
  if (first === RUN_WORD) return readRun(rest);
  if (first === PASSWORD_WORD) return readPassword(rest);
  if (first === IMPORT_WORD) return readImport(rest);
  if (first === EXPORT_WORD) return readExport(rest);
  const { name } = splitOption(first);
  if (WEB_FLAGS.includes(name)) return readWeb(argv);
  return { kind: "pi", arguments: argv };
}

/** The flags that, as a first word, make the command line the web interface's. */
const WEB_FLAGS: readonly string[] = [WEB_FLAG, PORT_FLAG, HOST_FLAG, PASSWORD_FLAG];

/**
 * The password is asked for at the terminal, never read from the command
 * line, where it would sit in the shell's history; so there is nothing here to read.
 */
function readPassword(argv: readonly string[]): Command {
  const [stray] = argv;
  if (stray === undefined) return { kind: "password" };
  if (HELP_FLAGS.includes(stray)) return help;
  return mistake(
    isOption(stray)
      ? `Unknown option "${stray}".`
      : `The password is asked for, not given here, so "${stray}" is a stray argument.`,
  );
}

/**
 * Two files and nothing else: the session to read and the Notebook to write,
 * in that order, as `cp` takes them. A `--help` anywhere among them asks for
 * the usage; any other option is not one this takes.
 */
function readImport(argv: readonly string[]): Command {
  if (argv.some((argument) => HELP_FLAGS.includes(argument))) return help;
  const option = argv.find(isOption);
  if (option !== undefined) return mistake(`Unknown option "${option}".`);

  const [session, notebook, stray] = argv;
  if (session === undefined) return mistake("A pi session file to import is needed.");
  if (notebook === undefined) return mistake("A notebook to write the session to is needed.");
  if (stray !== undefined) {
    return mistake(`One session is imported into one notebook, so "${stray}" is a stray argument.`);
  }
  return { kind: "import", session, notebook };
}

/**
 * Two files and, at most, which Run: the Notebook to read and the document to
 * write, in that order as `import` takes its two, and `--run` naming a Run
 * other than the latest. Anything else is a mistake, as everywhere here.
 */
function readExport(argv: readonly string[]): Command {
  const files: string[] = [];
  let run: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (HELP_FLAGS.includes(argument)) return help;
    if (!isOption(argument)) {
      files.push(argument);
      continue;
    }
    const { name, attached } = splitOption(argument);
    if (name !== RUN_FLAG) return mistake(`Unknown option "${argument}".`);
    if (run !== undefined) return mistake(`Option "${RUN_FLAG}" was given twice.`);
    run = valueOf(attached, argv[index + 1]);
    if (run === undefined) return mistake(`Option "${RUN_FLAG}" needs a run id.`);
    if (attached === undefined) index += 1;
  }

  const [notebook, document, stray] = files;
  if (notebook === undefined) return mistake("A notebook to export is needed.");
  if (document === undefined) return mistake("A document to write the export to is needed.");
  if (stray !== undefined) {
    return mistake(
      `One notebook is exported into one document, so "${stray}" is a stray argument.`,
    );
  }
  return { kind: "export", notebook, document, ...(run !== undefined ? { run } : {}) };
}

function readRun(argv: readonly string[]): Command {
  const inputs: Record<string, string> = {};
  let notebook: string | undefined;
  let trust: boolean | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (HELP_FLAGS.includes(argument)) return help;

    if (!isOption(argument)) {
      if (notebook !== undefined) {
        return mistake(`Only one notebook can be run, so "${argument}" is a stray argument.`);
      }
      notebook = argument;
      continue;
    }

    if (!argument.startsWith("--")) return mistake(`Unknown option "${argument}".`);

    const { name: option, attached } = splitOption(argument);
    const name = option.slice(2);

    if (!isName(name)) return mistake(`Unknown option "${argument}".`);

    // Read before the inputs, so the trust decision is never left to a name
    // collision; the parser reserves both names from Inputs for the same reason.
    const decision = TRUST_FLAGS.get(name);
    if (decision !== undefined) {
      if (attached !== undefined) return mistake(`Option "${option}" takes no value.`);
      if (trust !== undefined && trust !== decision) {
        return mistake("Either trust the workspace or don't, not both.");
      }
      trust = decision;
      continue;
    }
    if (Object.hasOwn(inputs, name)) return mistake(`Input "${name}" was given twice.`);

    const value = valueOf(attached, argv[index + 1]);
    if (value === undefined) return mistake(`Input "${option}" needs a value.`);
    inputs[name] = value;
    if (attached === undefined) index += 1;
  }

  if (notebook === undefined) return mistake("A notebook to run is needed.");
  return { kind: "run", notebook, inputs, ...(trust !== undefined ? { trust } : {}) };
}

/** A TCP port as written, or nothing: whole, and one a socket can be bound to. */
function readPort(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function readWeb(argv: readonly string[]): Command {
  let web = false;
  let password = false;
  let port: number | undefined;
  let host: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (HELP_FLAGS.includes(argument)) return help;

    const { name, attached } = splitOption(argument);

    if (name === WEB_FLAG || name === PASSWORD_FLAG) {
      if (attached !== undefined) return mistake(`Option "${name}" takes no value.`);
      if (name === WEB_FLAG) web = true;
      else password = true;
      continue;
    }
    if (name !== PORT_FLAG && name !== HOST_FLAG) {
      return mistake(
        isOption(argument)
          ? `Unknown option "${argument}".`
          : `The web interface takes no notebook, so "${argument}" is a stray argument.`,
      );
    }
    const wanted = name === PORT_FLAG ? "a port number" : "an address";
    if ((name === PORT_FLAG ? port : host) !== undefined) {
      return mistake(`Option "${name}" was given twice.`);
    }

    const text = valueOf(attached, argv[index + 1]);
    if (text === undefined) return mistake(`Option "${name}" needs ${wanted}.`);
    if (name === PORT_FLAG) {
      port = readPort(text);
      if (port === undefined) return mistake(`"${text}" is not a port number.`);
    } else host = text;
    if (attached === undefined) index += 1;
  }

  if (!web) {
    // Whichever web flag came first is the one most likely typed in place of `--web`.
    const given = splitOption(argv[0] ?? "").name;
    return mistake(`Option "${given}" only means something with "${WEB_FLAG}".`);
  }
  return {
    kind: "web",
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(password ? { password: true } : {}),
  };
}
