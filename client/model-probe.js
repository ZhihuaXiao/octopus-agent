// @ts-check
/**
 * A model test answers with one short line and, when opened, the rest.
 * Pi reports a failure as `401: {"message":…,"type":…,"code":…}` or
 * `OpenAI API error (401): …`, which is too wide to sit beside Test.
 */

/**
 * @typedef {object} ProbeDetail
 * @property {string} label
 * @property {string} value
 */

/**
 * @typedef {object} ProbeReport
 * @property {"ok" | "bad"} tone
 * @property {string} mark
 * @property {string} brief
 * @property {string} title
 * @property {ProbeDetail[]} details
 */

/**
 * @typedef {object} SplitProblem
 * @property {string} [source]
 * @property {number} [status]
 * @property {string} body
 */

/** The button whose result popup is open. */
/** @type {HTMLButtonElement | null} */
let owner = null;

/**
 * @param {{ available: boolean, problem?: string, inputTokens?: number, outputTokens?: number }} result
 * @returns {ProbeReport}
 */
export function probeReport(result) {
  const inputTokens = tokenCount(result.inputTokens);
  const outputTokens = tokenCount(result.outputTokens);
  if (result.available) {
    return {
      tone: "ok",
      mark: "Available",
      brief: `${inputTokens} in · ${outputTokens} out`,
      title: "Available",
      details: [
        { label: "Input tokens", value: String(inputTokens) },
        { label: "Output tokens", value: String(outputTokens) },
      ],
    };
  }

  const described = describeProblem(result.problem ?? "Unavailable");
  if (inputTokens > 0 || outputTokens > 0) {
    described.details.push(
      { label: "Input tokens", value: String(inputTokens) },
      { label: "Output tokens", value: String(outputTokens) },
    );
  }
  return {
    tone: "bad",
    mark: described.mark,
    brief: described.brief,
    title: "Unavailable",
    details: described.details,
  };
}

/**
 * The short line, drawn as a button that opens the full result.
 * @param {HTMLElement} status
 * @param {ProbeReport} report
 * @param {(anchor: HTMLButtonElement) => void} onOpen
 */
export function showProbeReport(status, report, onOpen) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `model-test-result ${report.tone}`;
  const mark = document.createElement("span");
  mark.className = "model-test-mark";
  mark.textContent = report.mark;
  button.append(mark);
  if (report.brief !== "") {
    const brief = document.createElement("span");
    brief.className = "model-test-brief";
    brief.textContent = report.brief;
    button.append(brief);
  }
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  const spoken = report.brief === "" ? report.mark : `${report.mark}, ${report.brief}`;
  button.setAttribute("aria-label", `${spoken}. Show details`);
  button.title = "Show the full result";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen(button);
  });
  status.replaceChildren(button);
}

/** @param {HTMLElement} status */
export function showProbePending(status) {
  const pending = document.createElement("span");
  pending.className = "model-test-pending";
  pending.textContent = "Testing…";
  status.replaceChildren(pending);
}

/**
 * @param {HTMLElement} popup
 * @param {HTMLButtonElement} anchor
 * @param {ProbeReport} report
 */
export function openProbePopup(popup, anchor, report) {
  if (owner === anchor && popup.matches(":popover-open")) {
    closeProbePopup(popup);
    return;
  }
  fillProbePopup(popup, report, () => closeProbePopup(popup));
  if (popup.matches(":popover-open")) popup.hidePopover();
  owner = anchor;
  anchor.setAttribute("aria-expanded", "true");
  popup.showPopover();
  placeProbePopup(popup, anchor);
}

/** @param {HTMLElement} popup */
export function closeProbePopup(popup) {
  if (popup.matches(":popover-open")) popup.hidePopover();
}

/** Clears the button that opened the popup, once the popup has closed. */
export function noteProbePopupClosed() {
  if (owner !== null) owner.setAttribute("aria-expanded", "false");
  owner = null;
}

/**
 * @param {string} problem
 * @returns {{ mark: string, brief: string, details: ProbeDetail[] }}
 */
function describeProblem(problem) {
  const split = splitProbeProblem(problem);
  /** @type {ProbeDetail[]} */
  const details = [];
  if (split.status !== undefined) details.push({ label: "Status", value: String(split.status) });
  if (split.source !== undefined) details.push({ label: "Source", value: split.source });

  const parsed = split.body === "" ? undefined : parseJson(split.body);
  /** @type {string | undefined} */
  let code;
  /** @type {string | undefined} */
  let type;
  /** @type {string | undefined} */
  let message;

  if (isRecord(parsed)) {
    const inner = isRecord(parsed.error) ? parsed.error : parsed;
    code = scalarField(inner, ["code", "error_code"]);
    type = scalarField(inner, ["type", "error_type"]);
    message =
      scalarField(inner, ["message", "error_message", "detail", "msg"]) ??
      (typeof inner.error === "string" && inner.error.trim() !== ""
        ? inner.error.trim()
        : undefined);
    if (code !== undefined) details.push({ label: "Code", value: code });
    if (type !== undefined) details.push({ label: "Type", value: type });
    if (message !== undefined) details.push({ label: "Message", value: message });
    pushExtras(
      details,
      inner,
      new Set([
        "code",
        "error_code",
        "type",
        "error_type",
        "message",
        "error_message",
        "detail",
        "msg",
        "error",
      ]),
    );
    if (inner !== parsed) {
      pushExtras(details, parsed, new Set(["error", ...(parsed.type === "error" ? ["type"] : [])]));
    }
  } else if (split.body !== "") {
    message = split.body;
    details.push({ label: "Message", value: split.body });
  }

  const brief = wordy(code)
    ? phrase(/** @type {string} */ (code))
    : wordy(type)
      ? phrase(/** @type {string} */ (type))
      : (message ?? (split.status !== undefined ? httpStatusPhrase(split.status) : "Unavailable"));
  return {
    mark: split.status !== undefined ? String(split.status) : "Failed",
    brief,
    details,
  };
}

/**
 * `401: body` is how pi writes a provider failure. `Name (401): body` is the
 * same thing with a provider prefix. A bare `401 Unauthorized` has no colon.
 * @param {string} problem
 * @returns {SplitProblem}
 */
function splitProbeProblem(problem) {
  const text = problem.trim();
  const coded = /^(\d{3})\s*:\s*([\s\S]*)$/.exec(text);
  if (coded !== null) return { status: Number(coded[1]), body: coded[2]?.trim() ?? "" };
  const prefixed = /^(.+?)\s+\((\d{3})\):\s*([\s\S]*)$/.exec(text);
  if (prefixed !== null) {
    const source = prefixed[1]?.trim() ?? "";
    const status = Number(prefixed[2]);
    const body = prefixed[3]?.trim() ?? "";
    return source === "" ? { status, body } : { source, status, body };
  }
  const bare = /^(\d{3})(?:\s+(\S[\s\S]*))?$/.exec(text);
  if (bare !== null) return { status: Number(bare[1]), body: bare[2]?.trim() ?? "" };
  return { body: text };
}

/**
 * @param {ProbeDetail[]} details
 * @param {Record<string, unknown>} record
 * @param {ReadonlySet<string>} skip
 */
function pushExtras(details, record, skip) {
  for (const [key, value] of Object.entries(record)) {
    if (skip.has(key) || value === undefined || value === null || value === "") continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    const text = detailText(value).trim();
    if (text === "") continue;
    details.push({ label: key, value: text });
  }
}

/** @param {number} status */
function httpStatusPhrase(status) {
  switch (status) {
    case 400:
      return "Bad request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not found";
    case 408:
      return "Timed out";
    case 409:
      return "Conflict";
    case 413:
      return "Too large";
    case 422:
      return "Rejected";
    case 429:
      return "Rate limited";
    case 500:
      return "Server error";
    case 502:
      return "Bad gateway";
    case 503:
      return "Unavailable";
    case 504:
      return "Timed out";
    default:
      return "Unavailable";
  }
}

/** `auth_unavailable` reads as "Auth unavailable" on the short line. @param {string} code */
function phrase(code) {
  const words = code.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  if (words === "") return code;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A code that is only a number repeats the status, so the line uses the message. @param {string | undefined} value */
function wordy(value) {
  return value !== undefined && /[a-z]/i.test(value);
}

/** @param {unknown} value */
function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** @param {string} text */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} record
 * @param {readonly string[]} keys
 * @returns {string | undefined}
 */
function scalarField(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** @param {unknown} value */
function detailText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/**
 * @param {HTMLElement} popup
 * @param {ProbeReport} report
 * @param {() => void} onClose
 */
function fillProbePopup(popup, report, onClose) {
  popup.replaceChildren();
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", report.title);
  const heading = document.createElement("div");
  heading.className = "model-test-popup-heading";
  const title = document.createElement("h3");
  title.className = report.tone;
  title.textContent = report.title;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  });
  heading.append(title, close);
  const list = document.createElement("dl");
  for (const detail of report.details) {
    const term = document.createElement("dt");
    term.textContent = detail.label;
    const value = document.createElement("dd");
    value.textContent = detail.value;
    list.append(term, value);
  }
  popup.append(heading, list);
}

/**
 * @param {HTMLElement} popup
 * @param {HTMLElement} anchor
 */
function placeProbePopup(popup, anchor) {
  const rect = anchor.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  let left = rect.right - popupRect.width;
  if (left < 8) left = 8;
  if (left + popupRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - popupRect.width - 8);
  }
  let top = rect.bottom + 4;
  if (top + popupRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - popupRect.height - 4);
  }
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}
