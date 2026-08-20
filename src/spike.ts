import { SessionManager, createAgentSession } from "@earendil-works/pi-coding-agent";

import { createAssistantTextStream } from "./pi/streaming.js";

/**
 * Proves the architecture in docs/adr/0001 end to end: pi embedded in our own
 * process, a prompt sent, and the reply streamed as it arrives.
 *
 * This is a spike. Ticket 02 replaces it with the agent interface behind which
 * all non-determinism lives.
 */
async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    process.stderr.write("usage: npm run spike -- <prompt>\n");
    process.exitCode = 1;
    return;
  }

  const { session } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    noTools: "all",
  });

  const stream = createAssistantTextStream();
  const unsubscribe = session.subscribe((event) => {
    const revealed = stream.accept(event);
    if (revealed) process.stdout.write(revealed);
  });

  try {
    await session.prompt(prompt);
    process.stdout.write("\n");
  } finally {
    unsubscribe();
    session.dispose();
  }
}

await main();
