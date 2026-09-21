import { describe, expect, it } from "vitest";

import { type Command, readCommand } from "./launcher.js";

/** Reads a command the test expects to be one of the launcher's own, reporting why if not. */
function command<K extends Command["kind"]>(argv: readonly string[], kind: K) {
  const result = readCommand(argv);
  if (result.kind === "mistake")
    throw new Error(`expected a ${kind} command, got: ${result.error}`);
  if (result.kind !== kind) throw new Error(`expected a ${kind} command, got a ${result.kind}`);
  return result as Extract<Command, { kind: K }>;
}

/** The complaint about a command line the test expects to be rejected. */
function rejected(argv: readonly string[]): string {
  const result = readCommand(argv);
  if (result.kind !== "mistake") throw new Error(`expected a mistake, got a ${result.kind}`);
  return result.error;
}

describe("a bare invocation", () => {
  it("is pi's, with nothing to say to it", () => {
    expect(readCommand([])).toEqual({ kind: "pi", arguments: [] });
  });

  it("hands pi whatever was said, as pi's own flags rather than ours", () => {
    expect(readCommand(["--model", "haiku", "-p", "hello"])).toEqual({
      kind: "pi",
      arguments: ["--model", "haiku", "-p", "hello"],
    });
  });

  it("hands pi a first word that is not one of our subcommands", () => {
    expect(readCommand(["install", "npm:pi-subagents"])).toEqual({
      kind: "pi",
      arguments: ["install", "npm:pi-subagents"],
    });
  });
});

describe("asking for help", () => {
  it.each(["--help", "-h", "help"])("with %s states the three behaviours", (word) => {
    const { usage } = command([word], "help");

    expect(usage).toContain("octo run");
    expect(usage).toContain("--web");
    expect(usage).toContain("pi");
  });
});

describe("the run subcommand", () => {
  const run = (...rest: string[]) => command(["run", ...rest], "run");

  it("reads the notebook to run", () => {
    expect(run("audit.md")).toEqual({ kind: "run", notebook: "audit.md", inputs: {} });
  });

  it("reads an input value written after its name", () => {
    expect(run("audit.md", "--target", "docs").inputs).toEqual({ target: "docs" });
  });

  it("reads an input value written with an equals sign", () => {
    expect(run("audit.md", "--target=docs").inputs).toEqual({ target: "docs" });
  });

  it("reads a value that would otherwise look like an option", () => {
    expect(run("audit.md", "--flags=--verbose").inputs).toEqual({ flags: "--verbose" });
  });

  it("reads a negative number as the value it looks like", () => {
    expect(run("audit.md", "--offset", "-1").inputs).toEqual({ offset: "-1" });
  });

  it("reads an input named after a property every object inherits", () => {
    expect(run("audit.md", "--constructor", "Ada").inputs).toEqual({ constructor: "Ada" });
  });

  it("reads inputs written before the notebook", () => {
    expect(run("--target", "docs", "audit.md")).toEqual({
      kind: "run",
      notebook: "audit.md",
      inputs: { target: "docs" },
    });
  });

  it("reports no notebook to run", () => {
    expect(rejected(["run"])).toContain("usage");
    expect(rejected(["run", "--target", "docs"])).toContain("usage");
  });

  it("reports a second notebook, which is more likely a stray argument", () => {
    expect(rejected(["run", "audit.md", "review.md"])).toContain('"review.md"');
  });

  it("reports an input with no value after it", () => {
    expect(rejected(["run", "audit.md", "--target"])).toContain('"--target" needs a value');
  });

  it("reports an input followed by another option rather than its value", () => {
    expect(rejected(["run", "audit.md", "--target", "--strict=true"])).toContain(
      '"--target" needs a value',
    );
  });

  it("reports the same input given twice rather than choosing between them", () => {
    expect(rejected(["run", "audit.md", "--target=docs", "--target=src"])).toContain("twice");
  });

  it("reports a single-dash option, which is not how inputs are written", () => {
    expect(rejected(["run", "audit.md", "-t", "docs"])).toContain('"-t"');
  });

  it("reports an option whose name no input could have, with the usage", () => {
    const error = rejected(["run", "audit.md", "--the target=docs"]);

    expect(error).toContain("the target");
    expect(error).toContain("usage");
  });

  it("answers a request for help rather than running anything", () => {
    expect(command(["run", "--help"], "help").usage).toContain("octo run");
  });

  it("runs a notebook that happens to be called help", () => {
    expect(run("help").notebook).toBe("help");
  });

  describe("deciding whether to trust the workspace", () => {
    it("leaves the decision unmade when neither flag is given", () => {
      expect(run("audit.md").trust).toBeUndefined();
    });

    it("reads a decision to trust the workspace", () => {
      expect(run("audit.md", "--trust").trust).toBe(true);
    });

    it("reads a decision not to trust it", () => {
      expect(run("audit.md", "--no-trust").trust).toBe(false);
    });

    it("keeps the flag out of the inputs, which is not what it is", () => {
      expect(run("audit.md", "--trust", "--target", "docs").inputs).toEqual({ target: "docs" });
    });

    it("takes no value, so the word after it is still an argument of its own", () => {
      expect(run("--trust", "audit.md").notebook).toBe("audit.md");
    });

    it("reports the two flags contradicting each other", () => {
      expect(rejected(["run", "audit.md", "--trust", "--no-trust"])).toContain("trust");
    });

    it("reports a value given to a flag that takes none", () => {
      expect(rejected(["run", "audit.md", "--trust=yes"])).toContain("--trust");
    });
  });
});

describe("the web flags", () => {
  it("start the server on a port of its choosing", () => {
    expect(command(["--web"], "web")).toEqual({ kind: "web" });
  });

  it("start the server on the port given", () => {
    expect(command(["--web", "--port", "8080"], "web").port).toBe(8080);
    expect(command(["--web", "--port=8080"], "web").port).toBe(8080);
  });

  it("may be written in either order", () => {
    expect(command(["--port", "8080", "--web"], "web").port).toBe(8080);
  });

  it("report a port with no number after it", () => {
    expect(rejected(["--web", "--port"])).toContain('"--port"');
  });

  it("report a port that is not a port number", () => {
    expect(rejected(["--web", "--port", "eighty"])).toContain('"eighty"');
    expect(rejected(["--web", "--port", "70000"])).toContain('"70000"');
    expect(rejected(["--web", "--port", "8080.5"])).toContain('"8080.5"');
  });

  it("report a value given to the web flag, which takes none", () => {
    expect(rejected(["--web=yes"])).toContain('"--web" takes no value');
  });

  it("report a port given twice", () => {
    expect(rejected(["--web", "--port=1", "--port=2"])).toContain("twice");
  });

  it("report a port given without the web interface it belongs to", () => {
    expect(rejected(["--port", "8080"])).toContain("--web");
  });

  it("report a flag that is neither, with the usage", () => {
    const error = rejected(["--web", "--prot", "8080"]);

    expect(error).toContain('"--prot"');
    expect(error).toContain("usage");
  });

  it("report a stray argument, with the usage", () => {
    expect(rejected(["--web", "audit.md"])).toContain('"audit.md"');
  });

  it("answer a request for help rather than starting anything", () => {
    expect(command(["--web", "--help"], "help").usage).toContain("--port");
  });

  describe("binding beyond loopback", () => {
    it("is not asked for unless the host flag is given", () => {
      expect(command(["--web"], "web")).not.toHaveProperty("host");
    });

    it("binds to the address given", () => {
      expect(command(["--web", "--host", "0.0.0.0"], "web").host).toBe("0.0.0.0");
      expect(command(["--web", "--host=::"], "web").host).toBe("::");
    });

    it("states the consequence in the help text, in so many words", () => {
      const { usage } = command(["--web", "--help"], "help");

      expect(usage).toContain("--host");
      expect(usage).toMatch(/arbitrary code/);
      expect(usage).toMatch(/as the user running octo/);
      expect(usage).toMatch(/SSH tunnel/);
    });

    it("reports a host with no address after it", () => {
      expect(rejected(["--web", "--host"])).toContain('"--host" needs an address');
      expect(rejected(["--web", "--host", "--port", "80"])).toContain('"--host" needs an address');
    });

    it("reports a host given twice", () => {
      expect(rejected(["--web", "--host=a", "--host=b"])).toContain("twice");
    });
  });

  describe("authenticating with the stored password", () => {
    it("is not asked for unless the password flag is given, leaving a token to be generated", () => {
      expect(command(["--web"], "web").password).toBeUndefined();
    });

    it("is asked for with the password flag", () => {
      expect(command(["--web", "--password"], "web").password).toBe(true);
    });

    it("reports a value given to the flag, which takes none", () => {
      expect(rejected(["--web", "--password=hunter2"])).toContain('"--password" takes no value');
    });
  });
});

describe("the password subcommand", () => {
  it("sets the password", () => {
    expect(readCommand(["password"])).toEqual({ kind: "password" });
  });

  it("takes nothing else: the password is asked for, never written on the command line", () => {
    expect(rejected(["password", "hunter2"])).toContain('"hunter2"');
    expect(rejected(["password", "--force"])).toContain('"--force"');
  });

  it("answers a request for help rather than asking for anything", () => {
    expect(command(["password", "--help"], "help").usage).toContain("octo password");
  });
});

describe("the import subcommand", () => {
  it("reads the chat's session file to import and the notebook to write", () => {
    expect(readCommand(["import", "chat.jsonl", "chat.md"])).toEqual({
      kind: "import",
      session: "chat.jsonl",
      notebook: "chat.md",
    });
  });

  it("reports a session with no notebook to write, and no session at all", () => {
    expect(rejected(["import", "chat.jsonl"])).toContain("notebook");
    expect(rejected(["import"])).toContain("session");
  });

  it("reports a stray argument, and an option it does not know", () => {
    expect(rejected(["import", "chat.jsonl", "chat.md", "other.md"])).toContain('"other.md"');
    expect(rejected(["import", "chat.jsonl", "chat.md", "--force"])).toContain('"--force"');
  });

  it("answers a request for help, which the usage says how to import in", () => {
    expect(command(["import", "--help"], "help").usage).toContain("octo import");
  });
});
