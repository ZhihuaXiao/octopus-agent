/**
 * The grammar for everything a Notebook addresses by name: Cell ids and Input
 * names.
 *
 * One grammar rather than two, because both are written where a name has to be
 * one bare word — a Cell id inside a fence's info string, an Input name inside
 * `{{ }}` — and an author who has learned how to spell one has learned both.
 */

/** Shared as its source so the reference syntax cannot drift from the rule. */
export const NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9_-]*";

/** How to spell a name, for the diagnostics that report one nothing can use. */
export const NAME_RULE =
  "must start with a letter or digit and use only letters, digits, dashes and underscores";

const NAME = new RegExp(`^${NAME_PATTERN}$`);

export const isName = (text: string): boolean => NAME.test(text);
