/**
 * The Notebook metadata carried in YAML frontmatter.
 *
 * Only ever reads. Serialising puts back the frontmatter text exactly as the
 * author wrote it, comments and blank lines included, so nothing here can
 * affect the bytes on disk — which is also why a real YAML parser is safe to
 * use for the reading.
 */

import { isMap, isScalar, isSeq, parseDocument, type ParsedNode } from "yaml";

import { type Diagnostic, lineOffset } from "./diagnostic.js";
import { DURATION_RULE, parseDuration } from "./duration.js";
import { INPUT_TYPES, type Input, type InputType, isInputType, settleDefault } from "./inputs.js";
import { NAME_RULE, isName } from "./name.js";

export interface Metadata {
  readonly title?: string;
  readonly mode?: string;
  readonly workspace?: string;
  readonly model?: string;
  /** Written `pi_version` in the Notebook. */
  readonly piVersion?: string;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly packages?: readonly string[];
  readonly inputs?: readonly Input[];
  /**
   * How long any Cell may run before the Run aborts it, in milliseconds, for
   * the Cells that do not say otherwise themselves. Written as a duration.
   */
  readonly timeout?: number;
}

const STRING_FIELDS = {
  title: "title",
  mode: "mode",
  workspace: "workspace",
  model: "model",
  pi_version: "piVersion",
} as const;

const LIST_FIELDS = { tools: "tools", skills: "skills", packages: "packages" } as const;

const INPUT_FIELDS = ["name", "type", "default", "description"] as const;

const FIELDS = [...Object.keys(STRING_FIELDS), ...Object.keys(LIST_FIELDS), "inputs", "timeout"];

function scalarString(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
}

function readInput(
  node: ParsedNode,
  lineOf: (offset: number) => number,
  errors: Diagnostic[],
): Input | undefined {
  if (!isMap(node)) {
    errors.push({ line: lineOf(node.range[0]), message: "Each input must be a mapping" });
    return undefined;
  }

  let name: string | undefined;
  let nameLine = lineOf(node.range[0]);
  let type: InputType | undefined;
  let description: string | undefined;
  let defaultLine: number | undefined;
  let value: unknown;

  for (const item of node.items) {
    const key = scalarString(item.key);
    const line = lineOf(item.key.range[0]);

    if (key === undefined) {
      errors.push({ line, message: "An input's field names must be strings" });
      continue;
    }
    if (!(INPUT_FIELDS as readonly string[]).includes(key)) {
      errors.push({
        line,
        message: `Unknown input field "${key}". Expected one of ${INPUT_FIELDS.join(", ")}`,
      });
      continue;
    }

    if (key === "default") {
      defaultLine = line;
      value = item.value === null ? null : item.value.toJSON();
      continue;
    }

    const scalar = scalarString(item.value);
    if (scalar === undefined) {
      errors.push({ line, message: `An input's "${key}" must be a string` });
      continue;
    }
    if (key === "name") {
      name = scalar;
      nameLine = line;
    }
    if (key === "description") description = scalar;
    if (key === "type") {
      if (!isInputType(scalar)) {
        errors.push({
          line,
          message: `Unknown input type "${scalar}". Expected one of ${INPUT_TYPES.join(", ")}`,
        });
        continue;
      }
      type = scalar;
    }
  }

  if (name === undefined) {
    errors.push({ line: lineOf(node.range[0]), message: "An input is missing its name" });
    return undefined;
  }
  // A name a Cell body could not spell is an Input nothing can reference, so
  // it is reported here rather than left to look like an unknown reference.
  if (!isName(name)) {
    errors.push({ line: nameLine, message: `Input name "${name}" ${NAME_RULE}` });
    return undefined;
  }

  if (defaultLine === undefined) {
    return {
      name,
      type: type ?? "string",
      ...(description !== undefined ? { description } : {}),
    };
  }

  const settled = settleDefault(name, type, value);
  if (!settled.ok) errors.push({ line: defaultLine, message: settled.problem });

  return {
    name,
    type: settled.ok ? settled.type : (type ?? "string"),
    ...(settled.ok ? { default: settled.value } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * Reads frontmatter YAML into Metadata, reporting anything the format contract
 * does not allow against the line it appears on.
 *
 * @param text the frontmatter between its delimiters
 * @param firstLine the Notebook line `text` starts on
 */
export function readMetadata(text: string, firstLine: number, errors: Diagnostic[]): Metadata {
  const parsed = parseDocument(text, { prettyErrors: false });
  const lineOf = (offset: number) => firstLine + lineOffset(text, offset);

  for (const error of parsed.errors) {
    errors.push({ line: lineOf(error.pos[0]), message: error.message });
  }
  if (parsed.errors.length > 0 || parsed.contents === null) return {};

  if (!isMap(parsed.contents)) {
    errors.push({ line: firstLine, message: "Frontmatter must be a mapping of fields" });
    return {};
  }

  const metadata: Record<string, unknown> = {};

  // Duplicate fields need no check here: YAML itself rejects a repeated key,
  // and that is reported above against the line it occurred on.
  for (const item of parsed.contents.items) {
    const key = scalarString(item.key);
    const line = lineOf(item.key.range[0]);

    if (key === undefined) {
      errors.push({ line, message: "Frontmatter field names must be strings" });
      continue;
    }

    if (key in STRING_FIELDS) {
      const value = scalarString(item.value);
      if (value === undefined) {
        errors.push({ line, message: `Frontmatter field "${key}" must be a string` });
        continue;
      }
      metadata[STRING_FIELDS[key as keyof typeof STRING_FIELDS]] = value;
      continue;
    }

    if (key in LIST_FIELDS) {
      if (!isSeq(item.value)) {
        errors.push({ line, message: `Frontmatter field "${key}" must be a list of strings` });
        continue;
      }
      const values: string[] = [];
      for (const element of item.value.items) {
        const value = scalarString(element);
        if (value === undefined) {
          errors.push({
            line: lineOf(element.range[0]),
            message: `Every entry in "${key}" must be a string`,
          });
          continue;
        }
        values.push(value);
      }
      metadata[LIST_FIELDS[key as keyof typeof LIST_FIELDS]] = values;
      continue;
    }

    if (key === "inputs") {
      if (!isSeq(item.value)) {
        errors.push({ line, message: `Frontmatter field "inputs" must be a list` });
        continue;
      }
      const inputs: Input[] = [];
      const names = new Set<string>();
      for (const element of item.value.items) {
        const input = readInput(element, lineOf, errors);
        if (!input) continue;
        if (names.has(input.name)) {
          errors.push({
            line: lineOf(element.range[0]),
            message: `Duplicate input "${input.name}"`,
          });
          continue;
        }
        names.add(input.name);
        inputs.push(input);
      }
      metadata.inputs = inputs;
      continue;
    }

    if (key === "timeout") {
      // A string, and only a string: YAML reads `30` as a number and `30s` as a
      // string, and the unit is what the duration rule is there to insist on.
      const value = scalarString(item.value);
      const timeout = value === undefined ? undefined : parseDuration(value);
      if (timeout === undefined) {
        errors.push({ line, message: `Frontmatter field "timeout" ${DURATION_RULE}` });
        continue;
      }
      metadata.timeout = timeout;
      continue;
    }

    errors.push({
      line,
      message: `Unknown frontmatter field "${key}". Expected one of ${FIELDS.join(", ")}`,
    });
  }

  return metadata as Metadata;
}
