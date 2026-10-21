/**
 * The model a Notebook names, `provider/id`.
 *
 * Pi's own `--model` parsing reads the provider as a hint rather than a name:
 * it matches the prefix without regard to case and, when several providers
 * offer the same model id, takes the one that comes first in its catalog. A
 * custom provider spelled `Azure` beside pi's built-in `azure` is resolved to
 * the built-in, whose provider has no key — so a Notebook that named a model it
 * can call is refused as one it cannot.
 *
 * A Notebook's model is written down, and accepted when it is assigned, as an
 * exact pair. So it is resolved as a pair. A name that is not a pair at all —
 * a hand-written Notebook, or a mode that names a bare id — is left to pi's
 * parsing, which is what it is good at.
 */

import {
  type ModelRuntime,
  type AgentSession,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

// Derived from pi's own signature rather than imported: the model type lives in
// @earendil-works/pi-ai, which is pi's dependency and not ours to pin.
type Model = Parameters<AgentSession["setModel"]>[0];

export interface NamedModel {
  readonly model?: Model;
  /** Pi's own words for why the name resolved to nothing. */
  readonly error?: string;
}

/** The model `named` means, `provider/id` exactly when that is what it is. */
export function namedModel(runtime: ModelRuntime, named: string): NamedModel {
  const slash = named.indexOf("/");
  if (slash > 0) {
    const exact = runtime.getModel(named.slice(0, slash), named.slice(slash + 1));
    if (exact !== undefined) return { model: exact };
  }
  const { model, error } = resolveCliModel({ cliModel: named, modelRuntime: runtime });
  return {
    ...(model !== undefined ? { model } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
