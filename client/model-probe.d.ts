/**
 * Types for the browser module. The implementation is `model-probe.js`, which
 * `tsc -p client` checks. This file lets the server typecheck import it.
 */

export interface ProbeDetail {
  label: string;
  value: string;
}

export interface ProbeReport {
  tone: "ok" | "bad";
  mark: string;
  brief: string;
  title: string;
  details: ProbeDetail[];
}

export function probeReport(result: {
  available: boolean;
  problem?: string;
  inputTokens?: number;
  outputTokens?: number;
}): ProbeReport;

/** The short line, drawn as a button that opens the full result. */
export function showProbeReport(
  status: HTMLElement,
  report: ProbeReport,
  onOpen: (anchor: HTMLButtonElement) => void,
): void;

export function showProbePending(status: HTMLElement): void;

export function openProbePopup(
  popup: HTMLElement,
  anchor: HTMLButtonElement,
  report: ProbeReport,
): void;

export function closeProbePopup(popup: HTMLElement): void;

/** Clears the button that opened the popup, once the popup has closed. */
export function noteProbePopupClosed(): void;
