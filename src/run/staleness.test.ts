/**
 * The staleness properties.
 *
 * Driven through `runNotebook` and asserted on the Run Record, like the run
 * order property beside it: what a Run left Stale is visible from the seam the
 * spec designates, so nothing here reaches into the Graph to see it.
 *
 * What the properties buy over the worked examples in `runner.test.ts` is the
 * closure that makes recovery work at all — that running a Run's Stale set
 * leaves nothing Stale, whatever the shape of the Graph and whatever subset of
 * it the Run named. Graphs are acyclic by construction, a Cell depending only on
 * Cells of lower rank, so every generated Notebook is one a parse would accept.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { createScriptedAgent } from "../agent/scripted.js";
import type { RunRecord } from "./record.js";
import { runNotebook } from "./runner.js";

interface GeneratedGraph {
  readonly source: string;
  /** Every Cell and the ids it uses, in the order the file writes them. */
  readonly cells: readonly { id: string; uses: readonly string[] }[];
}

const MOST_CELLS = 5;

const idOf = (rank: number) => `c${rank}`;
const ranks = (count: number) => Array.from({ length: count }, (_, rank) => rank);

/** A Notebook of Prompt Cells, each depending on Cells of lower rank than itself. */
function render(dependencies: readonly (readonly number[])[]): GeneratedGraph {
  const cells = dependencies.map((used, rank) => ({ id: idOf(rank), uses: used.map(idOf) }));

  const source = cells
    .map((cell) => {
      const uses = cell.uses.length > 0 ? ` uses=${cell.uses.join(",")}` : "";
      return `\`\`\`prompt id=${cell.id}${uses}\nDo ${cell.id}.\n\`\`\`\n`;
    })
    .join("\n");

  return { source, cells };
}

const graphsWhoseCellsUse = (
  chosen: (rank: number) => fc.Arbitrary<readonly number[]>,
): fc.Arbitrary<GeneratedGraph> =>
  fc
    .integer({ min: 1, max: MOST_CELLS })
    .chain((count) => fc.tuple(...ranks(count).map(chosen)))
    .map(render);

/**
 * Three shapes, because each one reaches what the others cannot.
 *
 * Sparse graphs are where Cells unrelated to a re-run live, and where a Run
 * names a set with a gap in it. Connected graphs leave nothing unrelated, so
 * every Cell is downstream of something. And straight chains are where
 * staleness has to travel further than one edge to be right, which a graph whose
 * every Cell depends on the first Cell directly would never show.
 */
const graphs = fc.oneof(
  graphsWhoseCellsUse((rank) => fc.subarray(ranks(rank))),
  graphsWhoseCellsUse((rank) => fc.subarray(ranks(rank), { minLength: Math.min(1, rank) })),
  graphsWhoseCellsUse((rank) => fc.constant(rank === 0 ? [] : [rank - 1])),
);

/** A graph with one of its Cells singled out, as re-running one Cell singles it out. */
const graphsWithOneCell = graphs.chain((graph) =>
  fc.constantFrom(...graph.cells.map((cell) => cell.id)).map((id) => ({ graph, id })),
);

/** A graph with some of its Cells named, which is what a re-run is given. */
const graphsWithSomeCells = graphs.chain((graph) =>
  fc
    .subarray(
      graph.cells.map((cell) => cell.id),
      { minLength: 1 },
    )
    .map((cells) => ({ graph, cells })),
);

/** Enough turns for any generated Notebook, none of which fails. */
const readyAgent = () =>
  createScriptedAgent(Array.from({ length: MOST_CELLS }, () => ({ text: "done" })));

/**
 * The Cells reachable from the named one along declared edges, worked out from
 * the generated graph rather than from the code under test.
 */
function dependentsOf(graph: GeneratedGraph, id: string): readonly string[] {
  const reached = new Set<string>();

  for (let grew = true; grew;) {
    grew = false;
    for (const cell of graph.cells) {
      if (reached.has(cell.id)) continue;
      if (!cell.uses.some((used) => used === id || reached.has(used))) continue;
      reached.add(cell.id);
      grew = true;
    }
  }

  return [...reached];
}

let directory: string;

/**
 * Runs a generated Notebook, as a fresh Run or as one carrying on from another.
 *
 * One directory for the whole suite, rewritten per case, as the run order
 * property does: the Records pile up harmlessly beside the Notebook.
 */
async function run(
  graph: GeneratedGraph,
  options: { cells?: readonly string[]; continues?: RunRecord } = {},
): Promise<RunRecord> {
  const path = join(directory, "notebook.md");
  await writeFile(path, graph.source, "utf8");

  return runNotebook(path, { agent: readyAgent().create, ...options });
}

describe("staleness properties", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "octo-stale-"));
  });

  it("leaves nothing stale when the whole notebook runs, whatever its shape", async () => {
    await fc.assert(
      fc.asyncProperty(graphs, async (graph) => {
        expect((await run(graph)).stale).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });

  it("marks exactly the dependents of a re-run cell stale", async () => {
    await fc.assert(
      fc.asyncProperty(graphsWithOneCell, async ({ graph, id }) => {
        const before = await run(graph);

        const record = await run(graph, { cells: [id], continues: before });

        expect([...record.stale].sort()).toEqual([...dependentsOf(graph, id)].sort());
      }),
      { numRuns: 40 },
    );
  });

  it("returns the notebook to fully valid when its stale cells are run", async () => {
    await fc.assert(
      fc.asyncProperty(graphsWithSomeCells, async ({ graph, cells }) => {
        const before = await run(graph);
        const partial = await run(graph, { cells, continues: before });

        // Whatever subset the previous run named, and whatever the edges among
        // them, one run of what it left stale is enough: the stale set is closed
        // under dependents, so nothing outside it was waiting on anything in it.
        const record = await run(graph, { cells: partial.stale, continues: partial });

        expect(record.stale).toEqual([]);
      }),
      { numRuns: 40 },
    );
  });
});
