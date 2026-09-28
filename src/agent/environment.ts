/**
 * The declared environment: what a Notebook says it needs, against what the
 * machine running it actually provides.
 *
 * Every difference stops the Run before its first Cell. A Notebook that
 * declares a skill and runs without it does not fail — it answers, plausibly
 * and wrongly, from a model that was never given the instructions the author
 * was relying on. That is the failure this module exists to convert into an
 * error, which is why a mismatch is refused rather than warned about.
 *
 * The comparison is by name and nothing more. Pi already decides what counts
 * as an installed skill or a resolved package; restating those rules here
 * would only be a second opinion to keep in step with pi's own.
 */

import type { Mode } from "../mode/mode.js";
import type { Metadata } from "../notebook/notebook.js";

/**
 * What an agent's surroundings offer a Run, as the agent boundary found them.
 *
 * Gathered once, when the agent is set up, so the Notebook's declarations are
 * checked against the environment the Cells will actually run in rather than
 * against one read separately and hoped to be the same.
 */
export interface Environment {
  /** The version of pi this Run embeds, which a Notebook may pin. */
  readonly piVersion: string;
  /** The tools the agent may use: the Notebook's own list when it declares one, else its Mode's. */
  readonly tools: readonly string[];
  /** The Skills pi loaded, by name. */
  readonly skills: readonly string[];
  /** The Packages pi has installed, by the source that names them. */
  readonly packages: readonly string[];
  /** Whether pi loaded the Workspace's own settings, skills and extensions. */
  readonly trusted: boolean;
}

/**
 * Reports everything the Notebook declares that this environment does not
 * provide, in the order the frontmatter declares it, and then everything its
 * Mode asks for that is not here either.
 *
 * Every problem at once rather than the first: the author is about to go and
 * install what is missing, and one round trip per missing skill wastes their
 * afternoon.
 */
export function checkEnvironment(
  declared: Metadata,
  provided: Environment,
  mode?: Mode,
): readonly string[] {
  const problems: string[] = [];

  if (declared.piVersion !== undefined && declared.piVersion !== provided.piVersion) {
    problems.push(
      `This notebook declares pi ${declared.piVersion}, but ${provided.piVersion} is running.`,
    );
  }

  // A missing skill or package is most often a Workspace whose own resources pi
  // declined to load, and that decision is invisible from where the author is
  // standing. Naming it here is the difference between a fixable error and a
  // baffling one.
  const untrusted = provided.trusted
    ? ""
    : " The workspace is not trusted, so pi loaded none of the resources it declares of its own.";

  const missing = (kind: string, name: string, hint = "", by = "This notebook") =>
    `${by} declares the ${kind} "${name}", which is not available here.${hint}`;

  for (const tool of declared.tools ?? []) {
    if (!provided.tools.includes(tool)) problems.push(missing("tool", tool));
  }
  for (const skill of declared.skills ?? []) {
    if (!provided.skills.includes(skill)) problems.push(missing("skill", skill, untrusted));
  }
  for (const source of declared.packages ?? []) {
    if (!provided.packages.includes(source)) problems.push(missing("package", source, untrusted));
  }

  if (mode !== undefined) {
    // Named after the Mode rather than the Notebook, since the Mode's file is
    // where somebody has to go to see why it was asked for.
    const by = `The mode "${mode.name}"`;
    // Only when the Notebook lists no tools of its own, which is when the
    // Mode's are the ones the agent was asked to have.
    if (declared.tools === undefined) {
      for (const tool of mode.tools ?? []) {
        if (!provided.tools.includes(tool)) problems.push(missing("tool", tool, "", by));
      }
    }
    for (const skill of mode.skills ?? []) {
      if (provided.skills.includes(skill) || declared.skills?.includes(skill)) continue;
      problems.push(missing("skill", skill, untrusted, by));
    }
  }

  return problems;
}
