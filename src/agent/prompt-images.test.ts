import { describe, expect, it } from "vitest";

import { extractPromptImages, formatPromptWithImages } from "./prompt-images.js";

describe("prompt-images", () => {
  it("leaves plain prompt text untouched when there are no images", () => {
    const prompt = "What is the capital of France?";
    const extracted = extractPromptImages(prompt);
    expect(extracted.text).toBe("What is the capital of France?");
    expect(extracted.images).toEqual([]);
  });

  it("extracts markdown image data URI and cleans text", () => {
    const rawData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";
    const prompt = `Analyze this graph:\n\n![Sales Trend](data:image/png;base64,${rawData})\n\nWhat is the peak?`;
    const extracted = extractPromptImages(prompt);

    expect(extracted.text).toBe("Analyze this graph:\n\n[Image: Sales Trend]\n\nWhat is the peak?");
    expect(extracted.images).toHaveLength(1);
    expect(extracted.images[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: rawData,
    });
  });

  it("handles multiple images (e.g. screenshot and PPT slide)", () => {
    const img1 = "AAAA";
    const img2 = "BBBB";
    const prompt = `Here is slide 1:\n![Slide 1](data:image/png;base64,${img1})\nAnd slide 2:\n![Slide 2](data:image/jpeg;base64,${img2})`;
    const extracted = extractPromptImages(prompt);

    expect(extracted.images).toHaveLength(2);
    expect(extracted.images[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: "AAAA",
    });
    expect(extracted.images[1]).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: "BBBB",
    });
    expect(extracted.text).toContain("[Image: Slide 1]");
    expect(extracted.text).toContain("[Image: Slide 2]");
  });

  it("strips whitespace/newlines within base64 data", () => {
    const prompt = "![Graph](data:image/webp;base64,a b\nc\r\nd==)";
    const extracted = extractPromptImages(prompt);
    expect(extracted.images[0]?.data).toBe("abcd==");
    expect(extracted.images[0]?.mimeType).toBe("image/webp");
  });

  it("extracts HTML img tags with data URIs", () => {
    const prompt = '<p>Check this:</p><img src="data:image/png;base64,1234==" alt="Chart">';
    const extracted = extractPromptImages(prompt);
    expect(extracted.images).toHaveLength(1);
    expect(extracted.images[0]?.data).toBe("1234==");
    expect(extracted.text).toBe("<p>Check this:</p>[Image]");
  });

  it("formats prompt text and images back to markdown", () => {
    const text = "Compare these two:";
    const images = [
      { alt: "Slide 1", dataUrl: "data:image/png;base64,111" },
      { alt: "Graph 2", dataUrl: "data:image/jpeg;base64,222" },
    ];
    const formatted = formatPromptWithImages(text, images);
    expect(formatted).toBe(
      "Compare these two:\n\n![Slide 1](data:image/png;base64,111)\n\n![Graph 2](data:image/jpeg;base64,222)",
    );
  });

  it("formats images without text cleanly", () => {
    const formatted = formatPromptWithImages("", [
      { alt: "Slide", dataUrl: "data:image/png;base64,111" },
    ]);
    expect(formatted).toBe("![Slide](data:image/png;base64,111)");
  });
});
