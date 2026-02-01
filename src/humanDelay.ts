/**
 * Human-like random delays for tab switches, category/subcategory navigation,
 * and pagination. Use these instead of fixed waits so automation looks less robotic.
 */

function randomBetween(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

/**
 * Wait a random number of milliseconds between minMs and maxMs (inclusive).
 */
export function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs <= maxMs ? randomBetween(minMs, maxMs) : minMs;
  return new Promise((r) => setTimeout(r, ms));
}

/** After clicking a tab (Recommended / Available / Additional): 1.5–4 s. */
export function delayAfterTabSwitch(): Promise<void> {
  return humanDelay(1500, 4000);
}

/** Before navigating to a category (e.g. clicking or goto): 0.5–1.5 s. */
export function delayBeforeCategory(): Promise<void> {
  return humanDelay(500, 1500);
}

/** After navigating to a category (page load): 1.5–3.5 s. */
export function delayAfterCategory(): Promise<void> {
  return humanDelay(1500, 3500);
}

/** Before navigating to a subcategory: 0.4–1.2 s. */
export function delayBeforeSubcategory(): Promise<void> {
  return humanDelay(400, 1200);
}

/** After navigating to a subcategory (page load): 1.2–3 s. */
export function delayAfterSubcategory(): Promise<void> {
  return humanDelay(1200, 3000);
}

/** Before clicking pagination (Next) or changing page: 0.8–2.5 s. */
export function delayBeforePagination(): Promise<void> {
  return humanDelay(800, 2500);
}

/** After pagination click / page load: 1.5–3.5 s. */
export function delayAfterPagination(): Promise<void> {
  return humanDelay(1500, 3500);
}
