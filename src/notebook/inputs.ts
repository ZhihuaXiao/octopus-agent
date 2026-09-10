/**
 * Inputs: the named, typed parameters a Notebook declares, and the Input
 * References to them inside Cell bodies.
 *
 * A reference is written `{{name}}` and replaced by the Input's value before
 * the Cell runs. The braces are the one sigil that collides with neither the
 * shell nor ordinary prose, and only a bare declared name is a reference, so
 * `{{.State.Status}}` in a `docker inspect` command is left as the Go template
 * it is. What the braces do collide with is Go's own `{{end}}`, which is why a
 * backslash escapes them. ADR-0009 has the reasoning.
 *
 * A reference to an Input the Notebook does not declare is a mistake rather
 * than text, so the parser reports it: a mistyped `{{taget}}` reaching the
 * model as itself is the sort of plausible wrong answer worth failing over.
 * Interpolation therefore never fails — by the time it runs, every reference
 * is known to name an Input, and every Input is known to have a value.
 */

import { NAME_PATTERN } from "./name.js";

export const INPUT_TYPES = ["string", "number", "boolean"] as const;

export type InputType = (typeof INPUT_TYPES)[number];

/**
 * Everything an Input can hold. Scalar only: a value has to read as itself
 * once interpolated into a prompt or a command, and a list does not.
 */
export type InputValue = string | number | boolean;

/** A named, typed parameter declared in a Notebook's frontmatter. */
export interface Input {
  readonly name: string;
  readonly type: InputType;
  readonly description?: string;
  /** Absent when the Input is required: a Run has to be given a value for it. */
  readonly default?: InputValue;
}

/** One value per declared Input, which is what a Run interpolates. */
export type InputValues = Readonly<Record<string, InputValue>>;

/** Where a Cell body refers to an Input. */
export interface Reference {
  readonly name: string;
  /** Where in the body it starts, so a diagnostic can name the line. */
  readonly offset: number;
}

export type Resolution =
  | { readonly ok: true; readonly values: InputValues }
  | { readonly ok: false; readonly errors: readonly string[] };

/** An Input's type and its default, settled against each other. */
export type SettledDefault =
  | { readonly ok: true; readonly type: InputType; readonly value: InputValue }
  | { readonly ok: false; readonly problem: string };

/**
 * The one reference no Notebook declares: `{{artifacts}}` is the directory the
 * Run gives the Cell for the files it produces, so it always resolves and is
 * the Run's to supply rather than the Notebook's to declare (ADR-0019). An
 * Input may not take the name, or a body could not say which it meant.
 */
export const ARTIFACTS_REFERENCE = "artifacts";

/**
 * The two long options a Run's command line keeps for itself, `--trust` and
 * `--no-trust` (ADR-0011), where every other one is an Input given its value.
 * An Input may not take either name, or `--trust` could not say which it meant;
 * reserved here in the format rather than resolved at the command line, so a
 * Notebook that would be ambiguous to run is reported when it is written
 * (ADR-0020). Each name maps to the decision it makes.
 */
export const TRUST_FLAGS: ReadonlyMap<string, boolean> = new Map([
  ["trust", true],
  ["no-trust", false],
]);

/** A reference, together with the backslash that would escape it. */
const REFERENCE = new RegExp(String.raw`(\\?)\{\{[ \t]*(${NAME_PATTERN})[ \t]*\}\}`, "g");

export const isInputType = (text: string): text is InputType =>
  (INPUT_TYPES as readonly string[]).includes(text);

/** The type an Input would need in order to hold this value, if any can. */
function typeOfValue(value: unknown): InputType | undefined {
  const type = typeof value;
  if (type === "string" || type === "boolean") return type;
  return type === "number" && Number.isFinite(value) ? "number" : undefined;
}

/**
 * Settles an Input's declared type against the default it declares.
 *
 * An undeclared type is taken from the default rather than assumed to be a
 * string, because YAML has already typed the scalar and `default: 3` reads as
 * a number to whoever wrote it. Only an Input with neither is a string.
 *
 * Reports the problem rather than the line it is on, which is the caller's to
 * know: this is the Input contract, not the frontmatter it was read from.
 */
export function settleDefault(
  name: string,
  declared: InputType | undefined,
  value: unknown,
): SettledDefault {
  const actual = typeOfValue(value);

  if (actual === undefined) {
    return { ok: false, problem: "An input's default must be a string, a number or a boolean" };
  }
  if (declared !== undefined && declared !== actual) {
    return {
      ok: false,
      problem: `Input "${name}" is a ${declared}, but its default is a ${actual}`,
    };
  }

  return { ok: true, type: actual, value: value as InputValue };
}

/** Every reference in a Cell body, in the order they are written. */
export function referencesIn(body: string): readonly Reference[] {
  const references: Reference[] = [];

  for (const match of body.matchAll(REFERENCE)) {
    const [, escape, name] = match;
    if (escape === "" && name !== undefined) references.push({ name, offset: match.index });
  }

  return references;
}

/**
 * Replaces every reference in a Cell body with its value.
 *
 * A reference to a name with no value is left as it was written, because the
 * parser has already reported it and a Run never gets this far.
 */
export function interpolate(body: string, values: InputValues): string {
  return body.replace(REFERENCE, (reference: string, escape: string, name: string) => {
    if (escape !== "") return reference.slice(escape.length);
    return Object.hasOwn(values, name) ? String(values[name]) : reference;
  });
}

/** Reads a value written as text — on a command line, or in a form. */
function readValue(text: string, type: InputType): InputValue | undefined {
  if (type === "string") return text;
  if (type === "boolean") return text === "true" ? true : text === "false" ? false : undefined;

  const value = Number(text);
  return text.trim() === "" || !Number.isFinite(value) ? undefined : value;
}

/**
 * Settles on the value of every declared Input, or on everything wrong with
 * the ones supplied.
 *
 * Every problem at once, and all of them before a Run starts: a Notebook whose
 * third Cell fails for want of an input has already spent the tokens of the
 * first two.
 */
export function resolveInputs(
  declared: readonly Input[],
  supplied: Readonly<Record<string, string>>,
): Resolution {
  const errors: string[] = [];
  const values: Record<string, InputValue> = {};
  const names = declared.map((input) => input.name);

  for (const name of Object.keys(supplied)) {
    if (names.includes(name)) continue;
    const declares =
      names.length === 0 ? "declares none" : `declares ${names.map((it) => `"${it}"`).join(", ")}`;
    errors.push(`No input named "${name}" is declared by this notebook, which ${declares}.`);
  }

  for (const input of declared) {
    const text = Object.hasOwn(supplied, input.name) ? supplied[input.name] : undefined;

    if (text === undefined) {
      if (input.default !== undefined) {
        values[input.name] = input.default;
        continue;
      }
      // Required is the absence of a default rather than a field of its own:
      // an Input with a default can always run, and one without never can.
      const detail = input.description === undefined ? "." : `: ${input.description}`;
      errors.push(`No value for the required input "${input.name}" (${input.type})${detail}`);
      continue;
    }

    const value = readValue(text, input.type);
    if (value === undefined) {
      errors.push(`Input "${input.name}" expects a ${input.type}, but was given "${text}".`);
      continue;
    }
    values[input.name] = value;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values };
}
