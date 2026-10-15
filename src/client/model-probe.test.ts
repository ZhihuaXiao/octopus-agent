import { describe, expect, it } from "vitest";

import { probeReport } from "../../client/model-probe.js";

const oauth =
  '401: {"message":"Encountered invalidated oauth token for user, failing request","type":"authentication_error","code":"auth_unavailable"}';

describe("a model test result", () => {
  it("keeps a provider failure to a status and a short reason", () => {
    const report = probeReport({
      available: false,
      problem: oauth,
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(report.tone).toBe("bad");
    expect(report.mark).toBe("401");
    expect(report.brief).toBe("Auth unavailable");
    expect(report.details).toEqual([
      { label: "Status", value: "401" },
      { label: "Code", value: "auth_unavailable" },
      { label: "Type", value: "authentication_error" },
      {
        label: "Message",
        value: "Encountered invalidated oauth token for user, failing request",
      },
    ]);
  });

  it("reads a provider prefix and an error object nested under error", () => {
    const report = probeReport({
      available: false,
      problem:
        'OpenAI API error (401): {"error":{"message":"nope","type":"auth"},"request_id":"abc"}',
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(report.mark).toBe("401");
    expect(report.brief).toBe("Auth");
    expect(report.details).toEqual([
      { label: "Status", value: "401" },
      { label: "Source", value: "OpenAI API error" },
      { label: "Type", value: "auth" },
      { label: "Message", value: "nope" },
      { label: "request_id", value: "abc" },
    ]);
  });

  it("leaves a plain failure as that sentence", () => {
    const report = probeReport({
      available: false,
      problem: "The model stopped: error.",
      inputTokens: 2,
      outputTokens: 0,
    });

    expect(report.mark).toBe("Failed");
    expect(report.brief).toBe("The model stopped: error.");
    expect(report.details).toEqual([
      { label: "Message", value: "The model stopped: error." },
      { label: "Input tokens", value: "2" },
      { label: "Output tokens", value: "0" },
    ]);
  });

  it("says a model that answered, with the tokens the check used", () => {
    expect(probeReport({ available: true, inputTokens: 7, outputTokens: 36 })).toEqual({
      tone: "ok",
      mark: "Available",
      brief: "7 in · 36 out",
      title: "Available",
      details: [
        { label: "Input tokens", value: "7" },
        { label: "Output tokens", value: "36" },
      ],
    });
  });

  it("uses the status phrase when the body carries nothing else", () => {
    const report = probeReport({
      available: false,
      problem: "429",
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(report.mark).toBe("429");
    expect(report.brief).toBe("Rate limited");
    expect(report.details).toEqual([{ label: "Status", value: "429" }]);
  });
});
