/**
 * The run order property.
 *
 * Driven through `runNotebook` and asserted on the Run Record, like every other
 * engine test: the order Cells ran in is visible from the seam the spec
 * designates, so nothing here needs to reach into the Graph to see it.
 *
 * What a property test buys over the worked examples beside it is the shapes
 * nobody would think to write down. Graphs are acyclic by construction rather
 * than by rejection — a Cell may only depend on one of lower rank — and the
 * document order is then a shuffle of those ranks, so almost every generated
 * Notebook declares at least one of its edges backwards.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { createScriptedAgent } from "../agent/scripted.js";
import { runNotebook } from "./runner.js";

interface GeneratedGraph {
  readonly source: string;
  /** Every Cell and the ids it uses, in the order the file writes them. */
  readonly cells: readonly { id: string; uses: readonly string[] }[];
}

const idOf = (rank: number) => `c${rank}`;
const ranks = (count: number) => Array.from({ length: count }, (_, rank) => rank);

/** A Notebook of Bash Cells, laid out in the order the ranks are given in. */
function render(order: readonly number[], dependencies: readonly (readonly number[])[]) {
  const cells = order.map((rank) => ({
    id: idOf(rank),
    uses: (dependencies[rank] ?? []).map(idOf),
  }));

  const source = cells
    .map((cell) => {
      const uses = cell.uses.length > 0 ? ` uses=${cell.uses.join(",")}` : "";
      return `\`\`\`bash id=${cell.id}${uses}\ntrue\n\`\`\`\n`;
    })
    .join("\n");

  return { source, cells };
}

const graphsOrderedBy = (
  ordering: (count: number) => fc.Arbitrary<readonly number[]>,
): fc.Arbitrary<GeneratedGraph> =>
  fc
    .integer({ min: 1, max: 6 })
    .chain((count) =>
      fc.record({
        dependencies: fc.tuple(...ranks(count).map((rank) => fc.subarray(ranks(rank)))),
        order: ordering(count),
      }),
    )
    .map(({ dependencies, order }) => render(order, dependencies));

const scrambled = graphsOrderedBy((count) =>
  fc.shuffledSubarray(ranks(count), { minLength: count, maxLength: count }),
);

/** Notebooks whose document order already satisfies every edge they declare. */
const alreadyInOrder = graphsOrderedBy((count) => fc.constant(ranks(count)));

// Bash Cells, so no turns are needed and the agent is never reached.
const unusedAgent = () => createScriptedAgent([]);

let directory: string;

/**
 * Runs a generated Notebook and reports the ids in the order they ran.
 *
 * One directory for the whole suite, rewritten per case: a Notebook this small
 * is quicker to overwrite than to give a temporary directory of its own, and
 * the Run Records pile up harmlessly beside it.
 */
async function ordered(graph: GeneratedGraph): Promise<readonly string[]> {
  const path = join(directory, "notebook.md");
  await writeFile(path, graph.source, "utf8");

  const record = await runNotebook(path, { agent: unusedAgent().create });
  return record.cells.map((cell) => cell.id);
}

describe("run order property", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "octo-order-"));
  });

  it("runs every cell exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(scrambled, async (graph) => {
        const order = await ordered(graph);

        expect([...order].sort()).toEqual(graph.cells.map((cell) => cell.id).sort());
      }),
      { numRuns: 60 },
    );
  });

  it("runs every cell after all the cells it uses", async () => {
    await fc.assert(
      fc.asyncProperty(scrambled, async (graph) => {
        const order = await ordered(graph);

        for (const cell of graph.cells) {
          for (const dependency of cell.uses) {
            expect(order.indexOf(dependency)).toBeLessThan(order.indexOf(cell.id));
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it("leaves the document order alone when it already satisfies every edge", async () => {
    await fc.assert(
      fc.asyncProperty(alreadyInOrder, async (graph) => {
        expect(await ordered(graph)).toEqual(graph.cells.map((cell) => cell.id));
      }),
      { numRuns: 60 },
    );
  });
});
