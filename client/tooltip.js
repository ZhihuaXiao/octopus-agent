// @ts-check

/**
 * Fast custom tooltip manager for buttons and interactive controls.
 * Shows tooltips with a responsive delay (150ms) and instant warm chaining,
 * replacing the slow native browser title delay.
 */

/** @type {HTMLDivElement | null} */
let tooltipEl = null;

/** @type {HTMLElement | null} */
let activeTarget = null;

/** @type {number | undefined} */
let showTimer = undefined;

/** @type {number} */
let lastHideTime = 0;

const COLD_DELAY_MS = 150;
const WARM_WINDOW_MS = 300;

/**
 * Initializes the global tooltip manager.
 */
export function initTooltips() {
  if (tooltipEl !== null) return;

  tooltipEl = document.createElement("div");
  tooltipEl.id = "app-tooltip";
  tooltipEl.className = "app-tooltip";
  tooltipEl.setAttribute("role", "tooltip");
  tooltipEl.setAttribute("aria-hidden", "true");
  document.body.append(tooltipEl);

  document.addEventListener("pointerover", onPointerOver);
  document.addEventListener("pointerout", onPointerOut);
  document.addEventListener("pointerdown", hideTooltip);
  window.addEventListener("scroll", hideTooltip, { capture: true, passive: true });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTooltip();
  });

  document.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    const target = /** @type {HTMLElement | null} */ (
      event.target.closest("[data-tooltip], [title]")
    );
    if (target !== null) {
      showForTarget(target, true);
    }
  });

  document.addEventListener("focusout", hideTooltip);
}

/**
 * @param {HTMLElement} target
 * @param {boolean} immediate
 */
function showForTarget(target, immediate) {
  if (
    target.matches(".tree-menu-button, .tree-menu-button *") ||
    target.closest("#sidebar .tree") !== null
  ) {
    return;
  }

  if (target === activeTarget && tooltipEl?.classList.contains("visible")) {
    return;
  }

  if (activeTarget !== null && activeTarget !== target) {
    hideTooltip();
  }

  // Extract title attribute if present, and transfer to data-tooltip to suppress native tooltip
  const titleAttr = target.getAttribute("title");
  let text = target.dataset.tooltip;
  if (titleAttr !== null && titleAttr !== "") {
    text = titleAttr;
    target.dataset.tooltip = titleAttr;
    target.removeAttribute("title");
  }

  if (!text || text.trim() === "") return;

  activeTarget = target;
  const isWarm = Date.now() - lastHideTime < WARM_WINDOW_MS;
  const delay = immediate || isWarm ? 0 : COLD_DELAY_MS;

  if (delay === 0) {
    displayTooltip(target, text);
  } else {
    showTimer = window.setTimeout(() => {
      if (activeTarget === target) {
        displayTooltip(target, text);
      }
    }, delay);
  }
}

/**
 * @param {HTMLElement} target
 * @param {string} text
 */
function displayTooltip(target, text) {
  if (tooltipEl === null || !target.isConnected) return;
  tooltipEl.textContent = text;
  tooltipEl.classList.add("visible");
  tooltipEl.setAttribute("aria-hidden", "false");
  positionTooltip(target);
}

/**
 * @param {HTMLElement} target
 */
function positionTooltip(target) {
  if (tooltipEl === null) return;
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltipEl.getBoundingClientRect();

  // Prefer placing below the target; flip to above if near viewport bottom
  let top = targetRect.bottom + 6;
  if (top + tooltipRect.height > window.innerHeight - 8) {
    top = targetRect.top - tooltipRect.height - 6;
  }
  top = Math.max(8, top);

  // Center horizontally relative to target
  let left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - tooltipRect.width - 8, left));

  tooltipEl.style.top = `${Math.round(top)}px`;
  tooltipEl.style.left = `${Math.round(left)}px`;
}

/**
 * Hides the currently visible tooltip.
 */
export function hideTooltip() {
  if (showTimer !== undefined) {
    window.clearTimeout(showTimer);
    showTimer = undefined;
  }
  if (activeTarget !== null) {
    const saved = activeTarget.dataset.tooltip;
    if (saved !== undefined && saved !== "") {
      activeTarget.setAttribute("title", saved);
    }
    activeTarget = null;
    lastHideTime = Date.now();
  }
  if (tooltipEl !== null) {
    tooltipEl.classList.remove("visible");
    tooltipEl.setAttribute("aria-hidden", "true");
  }
}

/**
 * @param {PointerEvent} event
 */
function onPointerOver(event) {
  if (!(event.target instanceof Element)) return;
  const target = /** @type {HTMLElement | null} */ (
    event.target.closest("[data-tooltip], [title]")
  );
  if (
    target === null ||
    target.matches(".tree-menu-button, .tree-menu-button *") ||
    target.closest("#sidebar .tree") !== null
  ) {
    if (activeTarget !== null) hideTooltip();
    return;
  }
  showForTarget(target, false);
}

/**
 * @param {PointerEvent} event
 */
function onPointerOut(event) {
  if (activeTarget === null) return;
  const related = event.relatedTarget;
  if (related instanceof Node && activeTarget.contains(related)) {
    return;
  }
  hideTooltip();
}

/**
 * Dynamically updates the tooltip text on an element.
 * @param {HTMLElement} element
 * @param {string} text
 */
export function updateTooltip(element, text) {
  element.dataset.tooltip = text;
  if (element !== activeTarget) {
    element.setAttribute("title", text);
  } else {
    displayTooltip(element, text);
  }
}
