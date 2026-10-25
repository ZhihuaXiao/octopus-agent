/**
 * Prompt image extraction and formatting.
 *
 * Prompt cells allow users to paste screenshots, graphs, or presentation
 * slides as images. In the notebook file, these are serialized as Markdown image
 * references with data URIs: `![alt](data:image/png;base64,...)`.
 *
 * When sending the turn to an agent, this module extracts the image data into
 * multimodal `ImageAttachment` blocks and cleans the text prompt so that the
 * LLM receives a clean prompt and vision input without being flooded with
 * raw base64 tokens.
 */

import type { ImageAttachment } from "./agent.js";

/** Matches Markdown image syntax with data:image/... URIs: ![alt](data:image/<mimeType>;base64,<data>) */
const MARKDOWN_DATA_IMAGE =
  /!\[([^\]]*)\]\((data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))\)/g;

/** Matches HTML <img> tags with data:image/... URIs */
const HTML_DATA_IMAGE =
  /<img\s+[^>]*src=["'](data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+))["'][^>]*>/gi;

export interface ExtractedPrompt {
  readonly text: string;
  readonly images: ImageAttachment[];
}

/**
 * Extracts data URI images from a prompt body, stripping the large base64 data
 * from the text so models receive clean text and real image attachments rather
 * than thousands of base64 text tokens.
 */
export function extractPromptImages(body: string): ExtractedPrompt {
  const images: ImageAttachment[] = [];

  // Replace Markdown images first
  let cleaned = body.replace(
    MARKDOWN_DATA_IMAGE,
    (_match, alt: string, _fullDataUri: string, mimeType: string, rawData: string) => {
      const data = rawData.replace(/\s+/g, "");
      images.push({
        type: "image",
        mimeType,
        data,
      });
      const label = alt.trim();
      return label ? `[Image: ${label}]` : "[Image]";
    },
  );

  // Replace HTML images if any
  cleaned = cleaned.replace(
    HTML_DATA_IMAGE,
    (_match, _fullDataUri: string, mimeType: string, rawData: string) => {
      const data = rawData.replace(/\s+/g, "");
      images.push({
        type: "image",
        mimeType,
        data,
      });
      return "[Image]";
    },
  );

  // Normalize excessive blank lines left after stripping image tags
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return { text: cleaned, images };
}

/**
 * Combines prompt text with image attachments back into Markdown format for
 * saving into the notebook document.
 */
export function formatPromptWithImages(
  text: string,
  images: readonly { readonly alt?: string; readonly dataUrl: string }[],
): string {
  const clean = text.trim();
  if (images.length === 0) return clean;
  const tags = images.map((img) => `![${img.alt?.trim() || "Graph"}](${img.dataUrl})`).join("\n\n");
  return clean ? `${clean}\n\n${tags}` : tags;
}
