import puppeteer, { Browser, Page } from "puppeteer";
import { config } from "./config.js";
import type { VineItem, VineTabId, TabCounts } from "./types.js";

const VINE_URL = "https://www.amazon.com/vine/vine-items";

const TAB_SELECTORS: Record<VineTabId, string> = {
  recommended: "Recommended for you",
  available: "Available for all",
  additional: "Additional items",
};

/** Extract ASIN from product URL (e.g. /dp/B0F93HFJBZ or amazon.com/dp/B0F93HFJBZ). */
export function extractAsin(href: string): string | null {
  const match = href.match(/\/dp\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : null;
}

async function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const EMAIL_SELECTORS = "#ap_email, input[name=email], input[type=email], input#ap_email";
const PASSWORD_SELECTORS = "#ap_password, input[name=password], input[type=password], input#ap_password";
const CONTINUE_SELECTORS = "#continue, input#continue, [data-action=continue]";
const SIGNIN_SELECTORS = "#signInSubmit, input#signInSubmit, input[type=submit]";

async function findAndClick(page: Page, selectors: string): Promise<boolean> {
  for (const sel of selectors.split(", ")) {
    const el = await page.$(sel.trim());
    if (el) {
      await el.click();
      return true;
    }
  }
  return false;
}

async function findAndType(page: Page, selectors: string, text: string): Promise<boolean> {
  for (const sel of selectors.split(", ")) {
    const el = await page.$(sel.trim());
    if (el) {
      await el.click();
      await wait(200);
      await el.evaluate((e) => {
        const input = e as HTMLInputElement;
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await el.type(text, { delay: 60 });
      return true;
    }
  }
  return false;
}

/**
 * Handle sign-in on the current page. Call this when we've navigated to Vine
 * and Amazon redirected us to the login page — do not navigate to ap/signin.
 */
async function signInOnCurrentPage(page: Page): Promise<void> {
  const { email, password } = config.amazon;

  // Wait for the sign-in form (email or password) to be present
  await Promise.race([
    page.waitForSelector(EMAIL_SELECTORS, { timeout: 15000 }),
    page.waitForSelector(PASSWORD_SELECTORS, { timeout: 15000 }),
  ]).catch(() => {});

  const hasEmail = await page.$(EMAIL_SELECTORS);
  const hasPassword = await page.$(PASSWORD_SELECTORS);

  if (hasEmail) {
    const typed = await findAndType(page, EMAIL_SELECTORS, email);
    if (!typed) await page.type("#ap_email", email, { delay: 60 });
    await wait(800);
    const continued = await findAndClick(page, CONTINUE_SELECTORS);
    if (continued) {
      await wait(2500);
      await page.waitForSelector(PASSWORD_SELECTORS, { timeout: 10000 }).catch(() => {});
    }
  }

  if (await page.$(PASSWORD_SELECTORS)) {
    const typed = await findAndType(page, PASSWORD_SELECTORS, password);
    if (!typed) await page.type("#ap_password", password, { delay: 60 });
    await wait(800);
    await findAndClick(page, SIGNIN_SELECTORS);
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await wait(4000);
  }

  // OTP / 2FA
  if (page.url().includes("ap/signin") || page.url().includes("ap/mfa")) {
    const otpSel = "#auth-mfa-otpcode, input[name=otpCode]";
    if (await page.$(otpSel)) {
      console.warn("Amazon is asking for OTP/2FA. Complete sign-in in the browser window.");
      await page.waitForNavigation({ timeout: 180000 }).catch(() => {});
    }
  }

  // Captcha / robot check
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes("Robot") || bodyText.includes("captcha") || bodyText.includes("unusual")) {
    console.warn("Amazon may be showing a captcha or security check. Complete it in the browser window.");
    await wait(60000);
  }
}

/** Get total result count for current tab from page text (e.g. "1-24 of 156"). */
async function getTotalCount(page: Page): Promise<number> {
  const text = await page.evaluate(() => document.body.innerText);
  const match = text.match(/(?:of|results?)\s*(\d+)/i) ?? text.match(/(\d+)\s*results?/i);
  if (match) return parseInt(match[1], 10);
  const ofMatch = text.match(/of\s+(\d+)/i);
  return ofMatch ? parseInt(ofMatch[1], 10) : 0;
}

/** Get max page number from Vine pagination (ul.a-pagination links with page=N). */
async function getMaxPageFromPagination(page: Page): Promise<number> {
  const maxPage = await page.evaluate(() => {
    const pag = document.querySelector("ul.a-pagination");
    if (!pag) return 0;
    const links = pag.querySelectorAll<HTMLAnchorElement>('a[href*="page="]');
    let max = 0;
    links.forEach((a) => {
      const m = a.getAttribute("href")?.match(/[?&]page=(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    });
    return max;
  });
  return maxPage;
}

/** Collect items from current Vine tab page (single page of results). */
async function extractItemsFromPage(
  page: Page,
  tab: VineTabId
): Promise<VineItem[]> {
  const items: VineItem[] = [];

  const rows = await page.$$('[data-component-type="s-search-result"], .vine-item, [data-asin]');
  const asinAttrRows = await page.$$('[data-asin]:not([data-asin=""])');

  const seenAsins = new Set<string>();

  for (const el of asinAttrRows) {
    const asin = await el.evaluate((e) => (e as HTMLElement).getAttribute("data-asin"));
    if (!asin || asin.length !== 10) continue;
    if (seenAsins.has(asin)) continue;
    seenAsins.add(asin);

    const linkEl = await el.$("a[href*='/dp/']");
    const href = linkEl ? await linkEl.evaluate((a) => (a as HTMLAnchorElement).href) : null;
    const productLink = href ?? `https://www.amazon.com/dp/${asin}`;

    let name = "";
    const titleEl = await el.$("h2 a, .a-text-normal[href*='/dp/']");
    if (titleEl) {
      name = await titleEl.evaluate((e) => (e as HTMLElement).textContent?.trim() ?? "");
    }
    if (!name) {
      const anyLink = await el.$("a[href*='/dp/']");
      if (anyLink) name = await anyLink.evaluate((e) => (e as HTMLElement).textContent?.trim() ?? "");
    }

    let imageUrl: string | null = null;
    const img = await el.$("img[src]");
    if (img) {
      imageUrl = await img.evaluate((i) => (i as HTMLImageElement).src);
    }

    items.push({
      asin,
      tab,
      name: name || `Product ${asin}`,
      link: productLink,
      imageUrl,
      seenAt: new Date(),
    });
  }

  if (items.length === 0) {
    const links = await page.$$('a[href*="/dp/"]');
    for (const a of links) {
      const href = await a.evaluate((el) => (el as HTMLAnchorElement).href);
      const asin = extractAsin(href);
      if (!asin || seenAsins.has(asin)) continue;
      seenAsins.add(asin);
      const name = await a.evaluate((el) => (el as HTMLElement).textContent?.trim() ?? "");
      const img = await page.$(`[data-asin="${asin}"] img, a[href*="/dp/${asin}"] img`);
      let imageUrl: string | null = null;
      if (img) imageUrl = await img.evaluate((i) => (i as HTMLImageElement).src);
      items.push({
        asin,
        tab,
        name: name || `Product ${asin}`,
        link: href,
        imageUrl,
        seenAt: new Date(),
      });
    }
  }

  return items;
}

/** Go to Vine, ensure we're on the given tab, return total count. */
async function openTabAndGetCount(
  page: Page,
  tab: VineTabId
): Promise<number> {
  await page.goto(VINE_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await wait(2000);

  const tabText = TAB_SELECTORS[tab];
  const clicked = await page.evaluate((text: string) => {
    const links = Array.from(document.querySelectorAll("a, span[role='button'], button"));
    const el = links.find((e: Element) => e.textContent?.trim() === text);
    if (el) {
      (el as HTMLElement).click();
      return true;
    }
    const partial = links.find((e: Element) => e.textContent?.trim().includes(text));
    if (partial) {
      (partial as HTMLElement).click();
      return true;
    }
    return false;
  }, tabText);
  if (clicked) await wait(2000);

  return getTotalCount(page);
}

/** Get total count for current tab (call after switching tab). */
async function getCurrentTabCount(page: Page): Promise<number> {
  return getTotalCount(page);
}

/** Try to go to the next page of results; return true if we moved. Logs when no more pages. */
async function goToNextPage(page: Page): Promise<boolean> {
  const selectors = [
    'a.s-pagination-next:not(.s-pagination-disabled)',
    '.s-pagination-next a:not(.s-pagination-disabled)',
    'a[aria-label="Next"]',
    '.a-last a',
    'li.a-last a',
    'a.s-pagination-item.s-pagination-next',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.evaluate((e: Element) => (e as HTMLElement).scrollIntoView({ block: "center" }));
      await wait(300);
      await el.click();
      await wait(2500);
      return true;
    }
  }
  // Click by link text "Next"
  const clicked = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a, button, span[role='button']"));
    const next = links.find((e) => /^Next\s*$/i.test((e as HTMLElement).textContent?.trim() ?? ""));
    if (next) {
      (next as HTMLElement).scrollIntoView({ block: "center" });
      (next as HTMLElement).click();
      return true;
    }
    return false;
  });
  if (clicked) {
    await wait(2500);
    return true;
  }
  // URL-based: Vine uses /vine/vine-items?queue=...&pn=&cn=&page=N — preserve query, increment page
  const url = page.url();
  if (url.includes("vine/vine-items")) {
    const pageMatch = url.match(/[?&]page=(\d+)/);
    const currentPage = pageMatch ? parseInt(pageMatch[1], 10) : 1;
    const nextNum = currentPage + 1;
    const base = url.replace(/[?&]page=\d+/, "").replace(/[?&]$/, "");
    const sep = base.includes("?") ? "&" : "?";
    const nextUrl = `${base}${sep}page=${nextNum}`;
    if (nextUrl !== url) {
      console.log(`[pagination] Navigating to page ${nextNum} via URL.`);
      await page.goto(nextUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
      await wait(2000);
      return true;
    }
  }
  console.log("[pagination] No more pages: no Next link/button and URL has no next page param.");
  return false;
}

/** Paginate through current tab and collect all items. Stops if a page has no new items (escape) or when maxItemsForTab reached. */
async function collectAllItemsInTab(
  page: Page,
  tab: VineTabId,
  totalCount: number,
  maxItemsForTab?: number,
  onItemsCollected?: (items: VineItem[]) => void
): Promise<VineItem[]> {
  const all: VineItem[] = [];
  const perPage = 24;
  const maxFromPagination = await getMaxPageFromPagination(page);
  const maxFromCount = Math.ceil(totalCount / perPage) || 1;
  const maxPages = Math.min(500, maxFromPagination || maxFromCount);
  if (maxFromPagination > 0) {
    console.log(`[pagination] Tab "${tab}": pagination shows ${maxFromPagination} page(s); will fetch up to ${maxPages}.`);
  }
  if (maxItemsForTab != null && maxItemsForTab > 0) {
    console.log(`[pagination] Tab "${tab}": cap at ${maxItemsForTab} item(s) for this tab.`);
  }

  for (let pageNum = 0; pageNum < maxPages; pageNum++) {
    if (pageNum > 0) {
      console.log(`[pagination] Tab "${tab}": changing to page ${pageNum + 1}...`);
      const moved = await goToNextPage(page);
      if (!moved) {
        console.log(`[pagination] Tab "${tab}": no more pages (could not go to page ${pageNum + 1}).`);
        break;
      }
      console.log(`[pagination] Tab "${tab}": now on page ${pageNum + 1}.`);
    } else {
      console.log(`[pagination] Tab "${tab}": on page 1 (of up to ${maxPages}).`);
    }

    const items = await extractItemsFromPage(page, tab);
    let newCount = 0;
    for (const it of items) {
      if (!all.some((i) => i.asin === it.asin)) {
        all.push(it);
        newCount++;
      }
    }
    if (onItemsCollected) onItemsCollected(items);
    console.log(`[pagination] Tab "${tab}" page ${pageNum + 1}: ${items.length} item(s) on page, ${newCount} new, ${all.length} total so far.`);

    if (maxItemsForTab != null && all.length >= maxItemsForTab) {
      console.log(`[pagination] Tab "${tab}": hit cap (${maxItemsForTab}); stopping.`);
      break;
    }
    if (items.length === 0 && pageNum > 0) {
      console.log(`[pagination] Tab "${tab}": no more pages (empty page).`);
      break;
    }
    if (items.length > 0 && newCount === 0) {
      console.log(`[pagination] Tab "${tab}": no more pages (all items already seen, escape).`);
      break;
    }
  }

  console.log(`[pagination] Tab "${tab}": done, ${all.length} item(s) collected.`);
  return all;
}

export interface ScraperResult {
  tabCounts: TabCounts;
  itemsByTab: Record<VineTabId, VineItem[]>;
  allItems: VineItem[];
  /** New items not yet sent in a batch (score these after scrape). */
  remainderNewItems: VineItem[];
}

export interface ScraperOptions {
  /** Stop collecting when total items across tabs reaches this (enforces AI max during scrape). */
  maxItems: number;
  /** ASINs already in DB; used to identify "new" items for pre-emptive batching. */
  seen: Set<string>;
  /** When new items buffer reaches this size, call onBatchNewItems and start AI. */
  batchSize: number;
  /** Called with a batch of new items so caller can run scoreAppeal in parallel. */
  onBatchNewItems: (batch: VineItem[]) => void;
}

/** Run full scrape: sign in, then for each tab get count and collect items. */
export async function runScraper(browser: Browser, options?: ScraperOptions): Promise<ScraperResult> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  try {
    await page.goto(VINE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await wait(3000);

    const needsSignIn =
      page.url().includes("ap/signin") ||
      page.url().includes("signin") ||
      (await page.$(EMAIL_SELECTORS)) != null;
    if (needsSignIn) {
      await signInOnCurrentPage(page);
      await page.goto(VINE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await wait(3000);
      if (page.url().includes("ap/signin") || (await page.$(EMAIL_SELECTORS))) {
        console.warn("Still on sign-in page. Complete login in the browser (e.g. captcha, 2FA). Waiting 90s for you to finish…");
        if (process.stdin.isTTY) {
          console.warn("Or press Enter in this terminal when done.");
          await Promise.race([
            new Promise<void>((r) => process.stdin.once("data", () => r())),
            wait(90000),
          ]);
        } else {
          await wait(90000);
        }
      }
    }

    const tabCounts: TabCounts = {
      recommended: 0,
      available: 0,
      additional: 0,
    };
    const itemsByTab: Record<VineTabId, VineItem[]> = {
      recommended: [],
      available: [],
      additional: [],
    };
    const maxItemsForRun = options?.maxItems ?? Infinity;
    let totalCollected = 0;
    const newItemsBuffer: VineItem[] = [];

    for (const tab of ["recommended", "available", "additional"] as VineTabId[]) {
      const count = await openTabAndGetCount(page, tab);
      tabCounts[tab] = count;
      if (count > 0) {
        const maxItemsThisTab = options ? Math.max(0, maxItemsForRun - totalCollected) : undefined;
        const onItemsCollected = options
          ? (itemsFromPage: VineItem[]) => {
              const newOnes = itemsFromPage.filter((it) => !options.seen.has(it.asin));
              newItemsBuffer.push(...newOnes);
              while (newItemsBuffer.length >= options.batchSize) {
                const batch = newItemsBuffer.splice(0, options.batchSize);
                options.onBatchNewItems(batch);
              }
            }
          : undefined;
        const items = await collectAllItemsInTab(
          page,
          tab,
          count,
          maxItemsThisTab,
          onItemsCollected
        );
        itemsByTab[tab] = items;
        totalCollected += items.length;
      }
    }

    const allItems: VineItem[] = [];
    const asinSet = new Set<string>();
    for (const arr of Object.values(itemsByTab)) {
      for (const it of arr) {
        if (!asinSet.has(it.asin)) {
          asinSet.add(it.asin);
          allItems.push(it);
        }
      }
    }

    return { tabCounts, itemsByTab, allItems, remainderNewItems: options ? newItemsBuffer : [] };
  } finally {
    await page.close();
  }
}

/** Only fetch current tab counts (lightweight check for increase detection). */
export async function fetchTabCounts(browser: Browser): Promise<TabCounts> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  try {
    await page.goto(VINE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await wait(3000);

    const needsSignIn =
      page.url().includes("ap/signin") ||
      page.url().includes("signin") ||
      (await page.$(EMAIL_SELECTORS)) != null;
    if (needsSignIn) {
      await signInOnCurrentPage(page);
      await page.goto(VINE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await wait(3000);
    }

    const tabCounts: TabCounts = {
      recommended: 0,
      available: 0,
      additional: 0,
    };

    for (const tab of ["recommended", "available", "additional"] as VineTabId[]) {
      tabCounts[tab] = await openTabAndGetCount(page, tab);
    }

    return tabCounts;
  } finally {
    await page.close();
  }
}
