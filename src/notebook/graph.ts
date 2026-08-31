/**
 * The Graph: a Notebook's Cells and the Dependencies they declare.
 *
 * Every edge is written by the author and none is inferred (ADR-0003), so
 * building the Graph is reading rather than guessing. What is left is to
 * establish that the edges are acyclic, and to turn them into the order the
 * Cells run in — which is the Graph's answer and not the document's, so a Cell
 * may be written before the Cell it uses.
 *
 * The check belongs to parsing (ADR-0012), and that is what makes the ordering
 * below total: by the time a Run asks for an order, every edge is known to name
 * a Cell and no chain of them closes. Ticket 09's staleness and ticket 10's
 * scheduler are further traversals of the same guarantee.
 */

import type { Diagnostic } from "./diagnostic.js";
import type { Cell } from "./notebook.js";

/** A Cell with the Notebook line its fence is on, so a problem can point at it. */
export interface PlacedCell {
  readonly cell: Cell;
  readonly line: number;
}

/**
 * A Cell with its edges resolved, which is the Graph in the shape a walk wants.
 *
 * Its line doubles as its position in the document, since Cells are placed in
 * the order the Notebook writes them and no two share a fence.
 */
interface Node extends PlacedCell {
  readonly dependencies: Node[];
}

/**
 * Rotates a cycle to begin at whichever of its Cells the Notebook writes first.
 *
 * So that which Cell a cycle is reported against is a property of the Notebook
 * rather than of where the walk below happened to start.
 */
function rotateToEarliest(cycle: readonly Node[]): [Node, ...Node[]] {
  const earliest = cycle.reduce((best, node) => (node.line < best.line ? node : best));
  const at = cycle.indexOf(earliest);
  return [earliest, ...cycle.slice(at + 1), ...cycle.slice(0, at)];
}

/**
 * The cycles among the declared edges, each as the Cells it runs through.
 *
 * One per edge found to close a loop. That names every tangle the Notebook has,
 * though not always in one pass: where two cycles share an edge, breaking the
 * reported one can reveal the other, and the Notebook stays refused until none
 * is left. Listing every distinct cycle instead is unbounded — a graph can hold
 * far more of them than an author would want to read — so the choice is between
 * a bounded report and a guaranteed single round trip, and the bound wins.
 */
function cyclesIn(nodes: readonly Node[]): readonly [Node, ...Node[]][] {
  const state = new Map<Node, "visiting" | "done">();
  const path: Node[] = [];
  const cycles: [Node, ...Node[]][] = [];

  const walk = (node: Node): void => {
    state.set(node, "visiting");
    path.push(node);

    for (const dependency of node.dependencies) {
      const seen = state.get(dependency);
      if (seen === undefined) walk(dependency);
      // Arriving back at a Cell the walk is still inside means this edge closes
      // a loop, and the loop is the part of the path from that Cell onwards.
      else if (seen === "visiting") {
        cycles.push(rotateToEarliest(path.slice(path.indexOf(dependency))));
      }
    }

    path.pop();
    state.set(node, "done");
  };

  for (const node of nodes) if (!state.has(node)) walk(node);

  return cycles;
}

/** Renders a cycle as it reads aloud: "audit uses review, which uses audit". */
function chainOf([start, ...rest]: readonly [Node, ...Node[]]): string {
  const onwards = [...rest, start].map((node) => node.cell.id);
  return `${start.cell.id} uses ${onwards.join(", which uses ")}`;
}

/**
 * Reports every declared edge that names no Cell, and every cycle they form.
 *
 * Both are the author's mistake and neither depends on the machine, which is
 * why they are Diagnostics against a line rather than a Run's refusal. Every
 * problem at once: an author untangling a set of edges should not have to
 * re-parse once per edge.
 */
export function checkGraph(placed: readonly PlacedCell[]): readonly Diagnostic[] {
  const problems: Diagnostic[] = [];
  const nodes: Node[] = placed.map((entry) => ({ ...entry, dependencies: [] }));
  const byId = new Map(nodes.map((node) => [node.cell.id, node]));

  for (const node of nodes) {
    for (const dependency of node.cell.uses) {
      const target = byId.get(dependency);
      // Reported rather than followed: an edge naming nothing has no place in
      // the walk below, and following it would only produce a second complaint
      // about the same typo.
      if (target) node.dependencies.push(target);
      else {
        problems.push({
          line: node.line,
          message: `Cell "${node.cell.id}" uses "${dependency}", which is not a cell in this notebook`,
        });
      }
    }
  }

  for (const cycle of cyclesIn(nodes)) {
    const [start] = cycle;
    problems.push({ line: start.line, message: `Dependency cycle: ${chainOf(cycle)}` });
  }

  return problems;
}

/**
 * The order a Notebook's Cells run in: a topological order of the Graph, with
 * document order breaking every tie (ADR-0013).
 *
 * The next Cell is always the earliest-written one whose Dependencies have all
 * run. So a Notebook declaring no edges runs top to bottom, and one declaring
 * them is disturbed no further than they require — a Cell is hoisted above
 * where it was written only when something above it says to wait for it.
 *
 * Throws when the Cells cannot be ordered, which the Cells of a parsed Notebook
 * never are: parsing refuses a cycle and an edge naming no Cell (ADR-0012), so
 * getting here is the caller's own bug rather than an author's mistake.
 */
export function runOrder(cells: readonly Cell[]): readonly Cell[] {
  const waiting = [...cells];
  const ran = new Set<string>();
  const order: Cell[] = [];

  while (waiting.length > 0) {
    const next = waiting.find((cell) => cell.uses.every((used) => ran.has(used)));
    if (next === undefined) {
      const stuck = waiting.map((cell) => `"${cell.id}"`).join(", ");
      throw new Error(`Cannot order the cells ${stuck}: their dependencies cannot be satisfied.`);
    }

    waiting.splice(waiting.indexOf(next), 1);
    order.push(next);
    ran.add(next.id);
  }

  return order;
}
