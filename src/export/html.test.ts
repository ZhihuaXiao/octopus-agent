import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createScriptedAgent } from "../agent/scripted.js";
import { runNotebook } from "../run/runner.js";
import { runDirectory } from "../run/store.js";
import { type ExportRequest, exportNotebook } from "./html.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "octo-export-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function notebookAt(name: string, contents: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents, "utf8");
  return path;
}

/**
 * Exports with nothing of the machine's own to hand — no environment, and pi's
 * agent directory somewhere empty — so that no test reads the credentials of
 * whoever runs it, and every one but those about credentials has none.
 */
async function exportOf(notebook: string, request: Partial<ExportRequest> = {}) {
  const exported = await exportNotebook({
    notebook,
    environment: {},
    agentDirectory: join(dir, "pi-agent"),
    ...request,
  });
  if (exported.kind !== "exported") throw new Error(`expected an export, got "${exported.kind}"`);
  return exported;
}

/**
 * The document as a reader sees it: the markup gone and the entities read
 * back, so a test says what the page says rather than how it is spelt.
 */
function textOf(document: string): string {
  return document
    .replace(/<(style|head)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const sum = `---
title: Sum
---

\`\`\`bash id=sum
echo "sum: $((40 + 2))"
\`\`\`
`;

describe("exportNotebook", () => {
  it("makes one document of a notebook and its latest run, and leaves the notebook as it was", async () => {
    const notebook = await notebookAt("sum.md", sum);
    const record = await runNotebook(notebook, { agent: createScriptedAgent([]).create });
    const before = await stat(notebook);

    const exported = await exportOf(notebook);

    expect(exported.run).toBe(record.id);
    expect(exported.document).toMatch(/^<!doctype html>/i);
    const text = textOf(exported.document);
    expect(text).toContain('echo "sum: $((40 + 2))"');
    expect(text).toContain("sum: 42");
    expect(await readFile(notebook, "utf8")).toBe(sum);
    expect((await stat(notebook)).mtimeMs).toBe(before.mtimeMs);
  });

  it("writes the same account as Markdown when asked", async () => {
    const notebook = await notebookAt(
      "sum.md",
      `---
title: Sum
---

Then the shell answers.

\`\`\`bash id=sum
echo "sum: $((40 + 2))"
echo '\`\`\`'
\`\`\`
`,
    );
    await runNotebook(notebook, { agent: createScriptedAgent([]).create });

    const exported = await exportOf(notebook, { format: "markdown" });

    expect(exported.document.startsWith("# Sum\n")).toBe(true);
    expect(exported.document).not.toContain("<html");
    expect(exported.document).toContain("Then the shell answers.");
    expect(exported.document).toContain("sum: 42");
    expect(exported.document).toMatch(/````bash\n/);
  });

  it("carries the title and the prose as written, each cell where it sits among it", async () => {
    const notebook = await notebookAt(
      "steps.md",
      `---
title: Q&A <draft>
---

Before the cells, with <b>markup</b> & an ampersand.

\`\`\`bash id=first
echo one
\`\`\`

Between them.

\`\`\`bash id=second
echo two
\`\`\`
`,
    );
    await runNotebook(notebook, { agent: createScriptedAgent([]).create });

    const { document } = await exportOf(notebook);

    expect(textOf(/<title>(.*?)<\/title>/.exec(document)?.[1] ?? "")).toBe("Q&A <draft>");
    const text = textOf(document);
    const order = [
      "Q&A <draft>",
      "Before the cells, with <b>markup</b> & an ampersand.",
      "echo one",
      "Between them.",
      "echo two",
    ].map((said) => text.indexOf(said));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("shows what a prompt cell's turn did, what it said, and the model and cost it ran on", async () => {
    const notebook = await notebookAt(
      "explain.md",
      "```prompt id=explain\nExplain what src/sum.ts does.\n```\n",
    );
    const agent = createScriptedAgent([
      {
        text: "It adds two numbers.",
        thinking: "reading the file first",
        model: "anthropic/claude-sonnet-4-5-20250929",
        usage: { inputTokens: 1200, outputTokens: 300, cost: 0.0123 },
        toolCalls: [
          { name: "read", input: { path: "src/sum.ts" } },
          { name: "bash", input: { command: "npm test -- sum" } },
        ],
      },
    ]);
    await runNotebook(notebook, { agent: agent.create });

    const text = textOf((await exportOf(notebook)).document);

    const order = [
      "Explain what src/sum.ts does.",
      "read",
      '"path": "src/sum.ts"',
      "bash",
      '"command": "npm test -- sum"',
      "Thinking",
      "reading the file first",
      "It adds two numbers.",
    ].map((said) => text.indexOf(said));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("anthropic/claude-sonnet-4-5-20250929");
    expect(text).toContain("$0.0123");
  });

  it("keeps whatever the agent wrote as text, and runs nothing and fetches nothing when it is opened", async () => {
    const notebook = await notebookAt("hostile.md", "```prompt id=page\nWrite a page.\n```\n");
    const hostile = `<script>alert(1)</script><img src=x onerror="alert(2)">`;
    const agent = createScriptedAgent([
      {
        text: hostile,
        thinking: hostile,
        toolCalls: [{ name: "<b>write</b>", input: { path: hostile } }],
      },
    ]);
    await runNotebook(notebook, { agent: agent.create });

    const { document } = await exportOf(notebook);

    expect(textOf(document)).toContain(hostile);
    expect(document).not.toMatch(/<script/i);
    expect(document).not.toMatch(/<img[^>]*onerror/i);
    const policy = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(document);
    expect(policy?.[1]).toMatch(/default-src 'none'/);
    expect(policy?.[1]).not.toMatch(/script-src/);
    const references = [...document.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((found) => found[1]);
    expect(references.filter((reference) => !/^(data:|#)/.test(reference ?? ""))).toEqual([]);
  });

  describe("which run", () => {
    const twoCells = `\`\`\`prompt id=a
First.
\`\`\`

\`\`\`prompt id=b uses=a
Second.
\`\`\`
`;

    it("exports the run named, and the latest when none is", async () => {
      const notebook = await notebookAt("two.md", twoCells);
      const first = await runNotebook(notebook, {
        agent: createScriptedAgent([{ text: "a once" }, { text: "b once" }]).create,
      });
      const second = await runNotebook(notebook, {
        agent: createScriptedAgent([{ text: "a twice" }, { text: "b twice" }]).create,
      });

      const named = await exportOf(notebook, { run: first.id });
      const latest = await exportOf(notebook);

      expect(named.run).toBe(first.id);
      expect(textOf(named.document)).toContain("a once");
      expect(textOf(named.document)).not.toContain("a twice");
      expect(latest.run).toBe(second.id);
      expect(textOf(latest.document)).toContain("b twice");
    });

    it("shows a cell the run did not touch as the run it continues left it, and says which cells are stale", async () => {
      const notebook = await notebookAt("two.md", twoCells);
      const whole = await runNotebook(notebook, {
        agent: createScriptedAgent([{ text: "a first time" }, { text: "b first time" }]).create,
      });
      const again = await runNotebook(notebook, {
        agent: createScriptedAgent([{ text: "a again" }]).create,
        cells: ["a"],
        continues: whole,
      });

      const text = textOf((await exportOf(notebook, { run: again.id })).document);

      expect(text).toContain("a again");
      expect(text).not.toContain("a first time");
      expect(text).toContain("b first time");
      expect(text).toMatch(/\bb\b[\s\S]*?\bstale\b/);
      // Said to be from the Run that ran it, since it is not the one exported.
      expect(text).toMatch(new RegExp(`\\bb\\b[\\s\\S]*?${whole.id}[\\s\\S]*?b first time`));
    });

    it("says why a bash cell failed, in what it wrote to standard error", async () => {
      const notebook = await notebookAt(
        "fails.md",
        '```bash id=missing\necho "the input file is missing" >&2\nexit 3\n```\n',
      );
      await runNotebook(notebook, { agent: createScriptedAgent([]).create });

      const text = textOf((await exportOf(notebook)).document);

      expect(text).toContain("Command exited with status 3");
      expect(text).toContain("the input file is missing");
    });

    it("says how a cell that failed failed, and that a cell that never ran never ran", async () => {
      const notebook = await notebookAt("two.md", twoCells);
      await runNotebook(notebook, {
        agent: createScriptedAgent([{ error: "The provider refused the request" }]).create,
      });

      const text = textOf((await exportOf(notebook)).document);

      expect(text).toContain("The provider refused the request");
      expect(text).toMatch(/\ba\b[\s\S]*?\berror\b/);
      expect(text).toMatch(/\bb\b[\s\S]*?not run\b/);
    });

    it("accounts for the run — its id, when it ran, and what it cost in all — and names nothing of the machine", async () => {
      const notebook = await notebookAt("two.md", twoCells);
      const record = await runNotebook(notebook, {
        agent: createScriptedAgent([
          { text: "a", usage: { inputTokens: 100, outputTokens: 10, cost: 0.01 } },
          { text: "b", usage: { inputTokens: 200, outputTokens: 20, cost: 0.025 } },
        ]).create,
      });

      const text = textOf((await exportOf(notebook)).document);

      expect(text).toContain(record.id);
      expect(text).toContain(record.startedAt);
      expect(text).toContain("$0.0350");
      expect(text).not.toContain(record.environment.workspace);
    });

    it("costs only the cells the notebook still has", async () => {
      const notebook = await notebookAt("two.md", twoCells);
      await runNotebook(notebook, {
        agent: createScriptedAgent([
          { text: "a", usage: { inputTokens: 100, outputTokens: 10, cost: 0.01 } },
          { text: "b", usage: { inputTokens: 200, outputTokens: 20, cost: 0.025 } },
        ]).create,
      });
      await writeFile(notebook, "```prompt id=a\nFirst.\n```\n", "utf8");

      const text = textOf((await exportOf(notebook)).document);

      expect(text).toContain("$0.0100");
      expect(text).not.toContain("$0.0350");
    });

    it("refuses a notebook that is not there, one that does not parse, and a run that never was", async () => {
      const request = { environment: {}, agentDirectory: join(dir, "pi-agent") };
      const absent = await exportNotebook({ ...request, notebook: join(dir, "missing.md") });
      const broken = await notebookAt("broken.md", "```prompt\nNo id.\n```\n");
      const invalid = await exportNotebook({ ...request, notebook: broken });
      const unrun = await notebookAt("unrun.md", sum);
      const neverRun = await exportNotebook({ ...request, notebook: unrun });
      await runNotebook(unrun, { agent: createScriptedAgent([]).create });
      const noSuchRun = await exportNotebook({ ...request, notebook: unrun, run: "nope" });

      expect(absent).toEqual({ kind: "absent" });
      expect(invalid).toMatchObject({ kind: "invalid" });
      expect((invalid as { problem: string }).problem).toContain("missing an id");
      expect(neverRun).toEqual({ kind: "no-run" });
      expect(noSuchRun).toEqual({ kind: "no-run" });
    });
  });

  describe("credentials", () => {
    const KEY = "sk-ant-api03-0123456789abcdefghijklmnop";
    const TOKEN = "ghp_9zYxWvUtSrQpOnMlKjIhGfEdCbA";

    /** Pi's agent directory as the machine would have it, with what it holds written in. */
    async function agentDirectoryWith(files: Readonly<Record<string, unknown>>) {
      const agentDirectory = join(dir, "pi-agent");
      await mkdir(agentDirectory, { recursive: true });
      for (const [name, contents] of Object.entries(files)) {
        await writeFile(join(agentDirectory, name), JSON.stringify(contents), "utf8");
      }
      return agentDirectory;
    }

    /** A Bash Cell that prints its argument, so a credential the machine holds lands in a record. */
    const printing = (what: string) => `\`\`\`bash id=leak\necho "${what}"\n\`\`\`\n`;

    it("redacts a credential from the environment wherever a cell repeated it", async () => {
      const notebook = await notebookAt("leak.md", printing(`key=${KEY} at /home/someone`));
      await runNotebook(notebook, { agent: createScriptedAgent([]).create });

      const text = textOf(
        (
          await exportOf(notebook, {
            environment: { MY_SERVICE_API_KEY: KEY, HOME: "/home/someone", SHORT_KEY: "abc" },
          })
        ).document,
      );

      expect(text).not.toContain(KEY);
      expect(text).toContain("key=[redacted] at /home/someone");
    });

    it("redacts the keys and tokens pi holds for its providers", async () => {
      const notebook = await notebookAt(
        "leak.md",
        printing(
          `anthropic ${KEY}; github ${TOKEN}; gateway gw-secret-value-1234; hdr h-1234567890`,
        ),
      );
      await runNotebook(notebook, { agent: createScriptedAgent([]).create });
      const agentDirectory = await agentDirectoryWith({
        "auth.json": {
          anthropic: { type: "api_key", key: KEY },
          "github-copilot": {
            type: "oauth",
            access: TOKEN,
            refresh: "refresh-0123456789",
            expires: 0,
          },
        },
        "models.json": {
          providers: {
            gateway: {
              apiKey: "gw-secret-value-1234",
              headers: { "x-auth": "h-1234567890" },
              models: [],
            },
          },
        },
      });

      const text = textOf((await exportOf(notebook, { agentDirectory })).document);

      expect(text).not.toContain(KEY);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("gw-secret-value-1234");
      expect(text).not.toContain("h-1234567890");
      expect(text).toContain(
        "anthropic [redacted]; github [redacted]; gateway [redacted]; hdr [redacted]",
      );
    });

    it("follows pi's references to the environment, and reads the environment a credential carries", async () => {
      const notebook = await notebookAt(
        "leak.md",
        printing(
          "gateway llm-gw-key-0123456789; bedrock bedrock-secret-abcdef; corp corp-gw-token-987654; region us-east-1",
        ),
      );
      await runNotebook(notebook, { agent: createScriptedAgent([]).create });
      const agentDirectory = await agentDirectoryWith({
        "auth.json": {
          openai: { type: "api_key", key: "$LLM_GATEWAY" },
          bedrock: {
            type: "api_key",
            key: "${BEDROCK}",
            env: { BEDROCK: "bedrock-secret-abcdef", AWS_REGION: "us-east-1" },
          },
        },
        "models.json": {
          providers: { corp: { headers: { authorization: "Bearer ${CORP_GW}" }, models: [] } },
        },
      });

      const text = textOf(
        (
          await exportOf(notebook, {
            agentDirectory,
            environment: { LLM_GATEWAY: "llm-gw-key-0123456789", CORP_GW: "corp-gw-token-987654" },
          })
        ).document,
      );

      expect(text).toContain(
        "gateway [redacted]; bedrock [redacted]; corp [redacted]; region us-east-1",
      );
    });

    it("never runs a command pi's config names to find a key", async () => {
      const notebook = await notebookAt("leak.md", printing("nothing"));
      await runNotebook(notebook, { agent: createScriptedAgent([]).create });
      const witness = join(dir, "ran");
      const agentDirectory = await agentDirectoryWith({
        "auth.json": { anthropic: { type: "api_key", key: `!touch ${witness}` } },
      });

      const exported = await exportOf(notebook, { agentDirectory });

      expect(exported.kind).toBe("exported");
      await expect(stat(witness)).rejects.toThrow();
    });

    it("redacts a credential in a tool call's summary even where the summary is cut through it", async () => {
      const notebook = await notebookAt("call.md", "```prompt id=fetch\nFetch it.\n```\n");
      const command = `curl --silent --fail --location https://api.example.com/v1/reports -H 'Bearer ${KEY}'`;
      expect(command.indexOf(KEY)).toBeLessThan(100);
      expect(command.indexOf(KEY) + KEY.length).toBeGreaterThan(100);
      await runNotebook(notebook, {
        agent: createScriptedAgent([
          { text: "Fetched.", toolCalls: [{ name: "bash", input: { command } }] },
        ]).create,
      });

      const text = textOf(
        (await exportOf(notebook, { environment: { ANTHROPIC_API_KEY: KEY } })).document,
      );

      expect(text).not.toContain(KEY.slice(0, 12));
    });

    it("withholds a binary artifact that holds a credential, and redacts a text one in both what is shown and what is offered", async () => {
      const notebook = await notebookAt(
        "leak.md",
        `\`\`\`bash id=leave
printf 'PNG\\x00\\x01%s' "${TOKEN}" > "{{artifacts}}/dump.png"
printf 'token: %s\\n' "${TOKEN}" > "{{artifacts}}/env.txt"
\`\`\`
`,
      );
      await runNotebook(notebook, { agent: createScriptedAgent([]).create });

      const { document } = await exportOf(notebook, { environment: { SECRET_TOKEN: TOKEN } });

      expect(document).not.toContain(Buffer.from(TOKEN).toString("base64").slice(4, 20));
      expect(document).not.toContain(TOKEN);
      expect(document).not.toMatch(/<img/);
      const text = textOf(document);
      expect(text).toMatch(/dump\.png[\s\S]*withheld/);
      expect(text).toContain("token: [redacted]");
      const link = /<a href="data:text\/plain;base64,([^"]+)" download="env.txt">/.exec(document);
      expect(Buffer.from(link?.[1] ?? "", "base64").toString("utf8")).toBe("token: [redacted]\n");
    });
  });

  describe("the files a run leaves", () => {
    /** A one-pixel PNG, as bytes and as the base64 a data URI carries. */
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );

    async function ranLeaving(files: Readonly<Record<string, Buffer | string>>) {
      const notebook = await notebookAt(
        "leaves.md",
        `\`\`\`bash id=leave
${Object.entries(files)
  .map(([name, bytes]) => {
    const encoded = Buffer.from(bytes).toString("base64");
    return `mkdir -p "$(dirname "{{artifacts}}/${name}")" && echo ${encoded} | base64 -d > "{{artifacts}}/${name}"`;
  })
  .join("\n")}
\`\`\`
`,
      );
      await runNotebook(notebook, { agent: createScriptedAgent([]).create });
      return notebook;
    }

    it("draws an image where the record names it, embedded", async () => {
      const notebook = await ranLeaving({ "chart.png": pixel });

      const { document } = await exportOf(notebook);

      const image = /<img src="data:image\/png;base64,([^"]+)" alt="([^"]*)">/.exec(document);
      expect(image?.[1]).toBe(pixel.toString("base64"));
      expect(image?.[2]).toBe("chart.png");
    });

    it("shows a text file inline and offers it for download under its own name", async () => {
      const notebook = await ranLeaving({ "notes/summary.md": "# Findings\n\nTwo & a <half>.\n" });

      const { document } = await exportOf(notebook);

      expect(textOf(document)).toContain("Two & a <half>.");
      const link = /<a href="data:text\/plain;base64,([^"]+)" download="([^"]*)">/.exec(document);
      expect(Buffer.from(link?.[1] ?? "", "base64").toString("utf8")).toBe(
        "# Findings\n\nTwo & a <half>.\n",
      );
      expect(link?.[2]).toBe("summary.md");
    });

    it("offers any other file for download only, never as a page", async () => {
      const page = "<html><script>alert(1)</script></html>";
      const notebook = await ranLeaving({
        "report.html": page,
        "data.bin": Buffer.from([0, 1, 2]),
      });

      const { document } = await exportOf(notebook);

      expect(document).not.toMatch(/<script/i);
      expect(document).toContain(
        `<a href="data:application/octet-stream;base64,${Buffer.from(page).toString("base64")}" download="report.html">`,
      );
      expect(document).toContain(
        `<a href="data:application/octet-stream;base64,${Buffer.from([0, 1, 2]).toString("base64")}" download="data.bin">`,
      );
    });

    it("says so of a file the record names that is no longer there, rather than leave it out unmentioned", async () => {
      const notebook = await ranLeaving({ "chart.png": pixel });
      const exportedBefore = await exportOf(notebook);
      await rm(join(runDirectory(notebook, exportedBefore.run), "artifacts", "leave", "chart.png"));

      const { document } = await exportOf(notebook);

      expect(document).not.toMatch(/<img/);
      expect(textOf(document)).toMatch(/chart\.png[\s\S]*?no longer there/);
    });
  });
});
