/**
 * The command line: one command with three behaviours.
 *
 * Invoked bare it is pi — whatever was said is handed to the real `pi`, flags
 * and all, so the terminal experience stays pi's own rather than a copy of it
 * that would drift. A `run` subcommand executes a Notebook headlessly. The web
 * flags start the server. The first word decides which, and only a word that
 * is ours is read here: anything else is pi's to make sense of, since a list
 * of pi's flags kept here would be one more thing to keep in step with a
 * package that ships breaking changes in one release in six.
 *
 * Within our own two, a mistake is reported rather than guessed at. A stray
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

const USAGE = `usage: octo [pi arguments]...
       octo run <notebook.md> [--trust|--no-trust] [--<input> <value>]...
       octo --web [--port <number>]

  A bare invocation is pi itself: anything not shown here is handed to the pi
  command as written, and only a request for help stops here instead.
  \`run\` executes a notebook headlessly, giving each declared input its value.
  \`--web\` starts the web interface, on the port given or one of its own.`;

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
    }
  | { readonly kind: "help"; readonly usage: string }
  | { readonly kind: "mistake"; readonly error: string };

const HELP_FLAGS: readonly string[] = ["--help", "-h"];
/** As a first word only: inside `run`, a bare `help` is a Notebook of that name. */
const HELP_WORD = "help";
const RUN_WORD = "run";
const WEB_FLAG = "--web";
const PORT_FLAG = "--port";

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
  const { name } = splitOption(first);
  if (name === WEB_FLAG || name === PORT_FLAG) return readWeb(argv);
  return { kind: "pi", arguments: argv };
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
  let port: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (HELP_FLAGS.includes(argument)) return help;

    const { name, attached } = splitOption(argument);

    if (name === WEB_FLAG) {
      if (attached !== undefined) return mistake(`Option "${WEB_FLAG}" takes no value.`);
      web = true;
      continue;
    }
    if (name !== PORT_FLAG) {
      return mistake(
        isOption(argument)
          ? `Unknown option "${argument}".`
          : `The web interface takes no notebook, so "${argument}" is a stray argument.`,
      );
    }
    if (port !== undefined) return mistake(`Option "${PORT_FLAG}" was given twice.`);

    const text = valueOf(attached, argv[index + 1]);
    if (text === undefined) return mistake(`Option "${PORT_FLAG}" needs a port number.`);
    port = readPort(text);
    if (port === undefined) return mistake(`"${text}" is not a port number.`);
    if (attached === undefined) index += 1;
  }

  if (!web) return mistake(`Option "${PORT_FLAG}" only means something with "${WEB_FLAG}".`);
  return { kind: "web", ...(port !== undefined ? { port } : {}) };
}
