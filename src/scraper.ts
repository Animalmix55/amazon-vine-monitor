import puppeteer, { Browser, Page } from "puppeteer";
import { config } from "./config.js";
import type { VineItem, VineTabId, TabCounts } from "./types.js";
import { filterSubcategoriesByGuidance } from "./ai.js";
import { getCategoryCounts, formatCategoryKey } from "./db.js";
import {
    delayAfterTabSwitch,
    delayBeforeCategory,
    delayAfterCategory,
    delayBeforeSubcategory,
    delayAfterSubcategory,
    delayBeforePagination,
    delayAfterPagination,
} from "./humanDelay.js";

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

const EMAIL_SELECTORS =
    "#ap_email, input[name=email], input[type=email], input#ap_email";
const PASSWORD_SELECTORS =
    "#ap_password, input[name=password], input[type=password], input#ap_password";
const CONTINUE_SELECTORS = "#continue, input#continue, [data-action=continue]";
const SIGNIN_SELECTORS =
    "#signInSubmit, input#signInSubmit, input[type=submit]";

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

async function findAndType(
    page: Page,
    selectors: string,
    text: string
): Promise<boolean> {
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
            await page
                .waitForSelector(PASSWORD_SELECTORS, { timeout: 10000 })
                .catch(() => {});
        }
    }

    if (await page.$(PASSWORD_SELECTORS)) {
        const typed = await findAndType(page, PASSWORD_SELECTORS, password);
        if (!typed) await page.type("#ap_password", password, { delay: 60 });
        await wait(800);
        await findAndClick(page, SIGNIN_SELECTORS);
        await page
            .waitForNavigation({
                waitUntil: "domcontentloaded",
                timeout: 30000,
            })
            .catch(() => {});
        await wait(4000);
    }

    // OTP / 2FA
    if (page.url().includes("ap/signin") || page.url().includes("ap/mfa")) {
        const otpSel = "#auth-mfa-otpcode, input[name=otpCode]";
        if (await page.$(otpSel)) {
            console.warn(
                "Amazon is asking for OTP/2FA. Complete sign-in in the browser window."
            );
            await page.waitForNavigation({ timeout: 180000 }).catch(() => {});
        }
    }

    // Captcha / robot check
    const bodyText = await page.evaluate(() => document.body.innerText);
    if (
        bodyText.includes("Robot") ||
        bodyText.includes("captcha") ||
        bodyText.includes("unusual")
    ) {
        console.warn(
            "Amazon may be showing a captcha or security check. Complete it in the browser window."
        );
        await wait(60000);
    }
}

/** Get total result count for current tab from page text (e.g. "1-24 of 156"). */
async function getTotalCount(page: Page): Promise<number> {
    const text = await page.evaluate(() => document.body.innerText);
    const match =
        text.match(/(?:of|results?)\s*(\d+)/i) ??
        text.match(/(\d+)\s*results?/i);
    if (match) return parseInt(match[1], 10);
    const ofMatch = text.match(/of\s+(\d+)/i);
    return ofMatch ? parseInt(ofMatch[1], 10) : 0;
}

/** Get max page number from Vine pagination (ul.a-pagination links with page=N). */
async function getMaxPageFromPagination(page: Page): Promise<number> {
    const maxPage = await page.evaluate(() => {
        const pag = document.querySelector("ul.a-pagination");
        if (!pag) return 0;
        const links =
            pag.querySelectorAll<HTMLAnchorElement>('a[href*="page="]');
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

/** Vine product tile: .vvp-item-tile with title in .a-truncate-full.a-offscreen, link in a[href*="/dp/"]. Returns items keyed by ASIN (uppercase). */
async function extractItemsFromPage(
    page: Page,
    tab: VineTabId
): Promise<Record<string, VineItem>> {
    const byAsin: Record<string, VineItem> = {};
    const seenAsins = new Set<string>();

    const vineTiles = await page.evaluate((baseUrl: string) => {
        const tiles = Array.from(document.querySelectorAll(".vvp-item-tile"));
        const result: {
            asin: string;
            name: string;
            link: string;
            imageUrl: string | null;
        }[] = [];
        const trim = (s: string | null | undefined) => (s ?? "").trim();
        for (const tile of tiles) {
            const link = tile.querySelector(
                'a.a-link-normal[href*="/dp/"]'
            ) as HTMLAnchorElement | null;
            if (!link) continue;
            const href = link.getAttribute("href") ?? "";
            const asinMatch = href.match(/\/dp\/([A-Z0-9]{10})/i);
            const asin = asinMatch ? asinMatch[1].toUpperCase() : null;
            if (!asin || asin.length !== 10) continue;
            const fullTitle = tile.querySelector(
                "span.a-truncate-full.a-offscreen"
            ) as HTMLElement | null;
            const name = fullTitle
                ? trim(fullTitle.textContent)
                : trim(
                      (
                          link.querySelector(
                              "span.a-truncate-cut"
                          ) as HTMLElement | null
                      )?.textContent
                  ) || trim(link.textContent);
            const productLink = href.startsWith("http")
                ? href
                : new URL(href, baseUrl).href;
            const img = tile.querySelector(
                "img[src]"
            ) as HTMLImageElement | null;
            const imgUrl =
                (tile as HTMLElement).getAttribute("data-img-url") ??
                img?.src ??
                null;
            result.push({
                asin,
                name: name || `Product ${asin}`,
                link: productLink,
                imageUrl: imgUrl,
            });
        }
        return result;
    }, "https://www.amazon.com");

    const now = new Date();
    for (const row of vineTiles) {
        if (seenAsins.has(row.asin)) continue;
        seenAsins.add(row.asin);
        const key = row.asin.toUpperCase();
        byAsin[key] = {
            asin: row.asin,
            tab,
            name: row.name,
            link: row.link,
            imageUrl: row.imageUrl,
            seenAt: now,
        };
    }

    if (Object.keys(byAsin).length === 0) {
        const links = await page.$$('a[href*="/dp/"]');
        for (const a of links) {
            const href = await a.evaluate(
                (el) => (el as HTMLAnchorElement).href
            );
            const asin = extractAsin(href);
            if (!asin || seenAsins.has(asin)) continue;
            seenAsins.add(asin);
            const name = await a.evaluate(
                (el) => (el as HTMLElement).textContent?.trim() ?? ""
            );
            const img = await page.$(
                `[data-asin="${asin}"] img, a[href*="/dp/${asin}"] img`
            );
            let imageUrl: string | null = null;
            if (img)
                imageUrl = await img.evaluate(
                    (i) => (i as HTMLImageElement).src
                );
            const key = asin.toUpperCase();
            byAsin[key] = {
                asin,
                tab,
                name: name || `Product ${asin}`,
                link: href,
                imageUrl,
                seenAt: new Date(),
            };
        }
    }

    return byAsin;
}

/** Go to Vine (if needed), switch to the given tab, return total count. Skips navigation when already on Vine items. */
async function openTabAndGetCount(page: Page, tab: VineTabId): Promise<number> {
    const url = page.url();
    if (!url.includes("vine/vine-items")) {
        await page.goto(VINE_URL, {
            waitUntil: "networkidle2",
            timeout: 60000,
        });
        await wait(2000);
    }

    const tabText = TAB_SELECTORS[tab];
    const clicked = await page.evaluate((text: string) => {
        const links = Array.from(
            document.querySelectorAll("a, span[role='button'], button")
        );
        const el = links.find((e: Element) => e.textContent?.trim() === text);
        if (el) {
            (el as HTMLElement).click();
            return true;
        }
        const partial = links.find((e: Element) =>
            e.textContent?.trim().includes(text)
        );
        if (partial) {
            (partial as HTMLElement).click();
            return true;
        }
        return false;
    }, tabText);
    if (clicked) await delayAfterTabSwitch();

    return getTotalCount(page);
}

/** Get total count for current tab (call after switching tab). */
async function getCurrentTabCount(page: Page): Promise<number> {
    return getTotalCount(page);
}

/** Try to go to the next page of results; return true if we moved. Logs when no more pages. */
async function goToNextPage(page: Page): Promise<boolean> {
    await delayBeforePagination();

    const selectors = [
        "a.s-pagination-next:not(.s-pagination-disabled)",
        ".s-pagination-next a:not(.s-pagination-disabled)",
        'a[aria-label="Next"]',
        ".a-last a",
        "li.a-last a",
        "a.s-pagination-item.s-pagination-next",
    ];
    for (const sel of selectors) {
        const el = await page.$(sel);
        if (el) {
            await el.evaluate((e: Element) =>
                (e as HTMLElement).scrollIntoView({ block: "center" })
            );
            await wait(200);
            await el.click();
            await delayAfterPagination();
            return true;
        }
    }
    // Click by link text "Next"
    const clicked = await page.evaluate(() => {
        const links = Array.from(
            document.querySelectorAll("a, button, span[role='button']")
        );
        const next = links.find((e) =>
            /^Next\s*$/i.test((e as HTMLElement).textContent?.trim() ?? "")
        );
        if (next) {
            (next as HTMLElement).scrollIntoView({ block: "center" });
            (next as HTMLElement).click();
            return true;
        }
        return false;
    });
    if (clicked) {
        await delayAfterPagination();
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
            await page.goto(nextUrl, {
                waitUntil: "domcontentloaded",
                timeout: 20000,
            });
            await delayAfterPagination();
            return true;
        }
    }
    console.log(
        "[pagination] No more pages: no Next link/button and URL has no next page param."
    );
    return false;
}

/** Fisher–Yates shuffle (in place). */
function shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** Skip if this category/sub mixes parts and accessories and has >800 items (not worth sifting). */
function shouldSkipPartsAndAccessoriesBucket(
    name: string,
    count: number
): boolean {
    if (count <= 800) return false;
    const lower = name.toLowerCase();
    const hasParts = /\bparts?\b/.test(lower);
    const hasAccessories = /\baccessor(y|ies)\b/.test(lower);
    return hasParts && hasAccessories;
}

const VVP_BROWSE_NODES = "#vvp-browse-nodes-container";

/** Top-level category from filter: name, category id, and item count. */
export interface CategoryNode {
    name: string;
    categoryId: string;
    count: number;
}

/** Subcategory under a selected category: name, subcategory id, and item count. */
export interface SubcategoryNode {
    name: string;
    subcategoryId: string;
    count: number;
}

/** Pending category/subcategory count update; committed only after notification is sent. */
export interface PendingCategoryUpdate {
    categoryId: string;
    subcategoryId: string | null;
    count: number;
    name?: string;
}

/**
 * Parse the Vine category filter (#vvp-browse-nodes-container) for all top-level
 * categories (div.parent-node) and their item count from the span, e.g. (7823).
 */
export async function getTopLevelCategories(
    page: Page
): Promise<CategoryNode[]> {
    const list = await page.evaluate((containerSel: string) => {
        const container = document.querySelector(containerSel);
        if (!container) return [];
        const parents = container.querySelectorAll("div.parent-node");
        const result: { name: string; categoryId: string; count: number }[] =
            [];
        parents.forEach((div) => {
            const a = div.querySelector("a[href*='pn=']");
            if (!a) return;
            const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
            const m = href.match(/[?&]pn=(\d+)/);
            if (!m) return;
            const name = (a as HTMLElement).textContent?.trim() ?? "";
            let count = 0;
            const span = a.nextElementSibling ?? div.querySelector("span");
            if (span) {
                const match = (span as HTMLElement).textContent?.match(
                    /\((\d+)\)/
                );
                if (match) count = parseInt(match[1], 10);
            }
            if (name) result.push({ name, categoryId: m[1], count });
        });
        return result;
    }, VVP_BROWSE_NODES);
    return list;
}

/**
 * Parse subcategories from the filter bar (#vvp-browse-nodes-container) for the
 * currently selected parent (a.selectedNode). Counts are read only from the filter
 * bar span next to each child-node link, e.g. "Replacement Parts" then span " (5944)".
 * Call this after navigating to a category so the filter shows that category and its subcategories.
 */
export async function getSubcategories(page: Page): Promise<SubcategoryNode[]> {
    const list = await page.evaluate((containerSel: string) => {
        const container = document.querySelector(containerSel);
        if (!container) return [];
        const selected = container.querySelector("a.selectedNode");
        if (!selected) return [];
        const parentDiv = selected.closest("div.parent-node");
        if (!parentDiv) return [];
        const result: { name: string; subcategoryId: string; count: number }[] =
            [];
        let next: Element | null = parentDiv.nextElementSibling;
        while (next) {
            if (next.classList.contains("parent-node")) break;
            if (next.classList.contains("child-node")) {
                const a = next.querySelector("a[href*='cn=']");
                if (a) {
                    const href =
                        (a as HTMLAnchorElement).getAttribute("href") ?? "";
                    const m = href.match(/[?&]cn=(\d+)/);
                    if (m) {
                        const name =
                            (a as HTMLElement).textContent?.trim() ?? "";
                        let count = 0;
                        const childDiv = next as HTMLElement;
                        const spanInFilter =
                            a.nextElementSibling?.nodeName === "SPAN"
                                ? (a.nextElementSibling as HTMLElement)
                                : childDiv.querySelector("span");
                        if (
                            spanInFilter &&
                            spanInFilter.closest(containerSel) !== null
                        ) {
                            const countMatch =
                                spanInFilter.textContent?.match(/\((\d+)\)/);
                            if (countMatch) count = parseInt(countMatch[1], 10);
                        }
                        if (name)
                            result.push({ name, subcategoryId: m[1], count });
                    }
                }
            }
            next = next.nextElementSibling;
        }
        return result;
    }, VVP_BROWSE_NODES);
    return list;
}

/** Options for collectUnseenItemsInTab and collectUnseenItemsSmart. */
export interface CollectUnseenItemsOptions {
    page: Page;
    tab: VineTabId;
    totalCount: number;
    maxItemsForTab?: number;
    getSeenAsins?: (desired: string[]) => Promise<Set<string>>;
    /** Called when a page (or chunk) of unseen items is ready; ties into runScraper batching. */
    onPageProcessed?: (items: VineItem[]) => void | Promise<void>;
}

/**
 * Smart collection for Additional items: open category filter, get top-level categories
 * (shuffled), then for each category get subcategories and use AI to pick which to scrape.
 * Only scrapes those subcategories (or the parent if none match). Falls back to
 * collectUnseenItemsInTab if the filter container is not present.
 * Returns items plus pending category updates; caller commits after notification.
 */
async function collectUnseenItemsSmart(
    options: CollectUnseenItemsOptions
): Promise<{
    unseenItems: Record<string, VineItem>;
    pendingCategoryUpdates: PendingCategoryUpdate[];
    seenCategoryKeys: Set<string>;
    visitedCategoryIds: Set<string>;
}> {
    const { page, tab, totalCount, maxItemsForTab, getSeenAsins, onPageProcessed } = options;
    const tabLabel = tab.charAt(0).toUpperCase() + tab.slice(1);
    await delayAfterTabSwitch();
    const hasFilter = await page.$(VVP_BROWSE_NODES).then((el) => !!el);
    if (!hasFilter) {
        console.log(
            `[${tabLabel}] No category filter found; scraping entire tab.`
        );
        const unseenItems = await collectUnseenItemsInTab(options);
        return {
            unseenItems,
            pendingCategoryUpdates: [],
            seenCategoryKeys: new Set(),
            visitedCategoryIds: new Set(),
        };
    }

    let categories = await getTopLevelCategories(page);
    if (categories.length === 0) {
        console.log(
            `[${tabLabel}] No top-level categories in filter; scraping entire tab.`
        );
        const unseenItems = await collectUnseenItemsInTab(options);
        return {
            unseenItems,
            pendingCategoryUpdates: [],
            seenCategoryKeys: new Set(),
            visitedCategoryIds: new Set(),
        };
    }

    const categoryCounts = await getCategoryCounts();
    const seenCategoryKeys = new Set<string>(
        categories.map((c) => c.categoryId)
    );
    const visitedCategoryIds = new Set<string>();
    const pendingCategoryUpdates: PendingCategoryUpdate[] = [];

    shuffle(categories);
    console.log(
        `[${tabLabel}] Smart mode: ${categories.length} top-level categories (shuffled), filtering subcategories by guidance.`
    );

    let unseenItems: Record<string, VineItem> = {};

    for (const category of categories) {
        if (
            maxItemsForTab != null &&
            Object.keys(unseenItems).length >= maxItemsForTab
        )
            break;

        console.log(`[${tabLabel}] Category: ${category.name}`);
        await delayBeforeCategory();
        const baseUrl = `${VINE_URL}?queue=encore&pn=${category.categoryId}`;
        await page.goto(baseUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
        });
        await delayAfterCategory();

        visitedCategoryIds.add(category.categoryId);
        await page
            .waitForSelector(`${VVP_BROWSE_NODES} a.selectedNode`, {
                timeout: 5000,
            })
            .catch(() => {});
        const subs = await getSubcategories(page);
        for (const sub of subs)
            seenCategoryKeys.add(
                formatCategoryKey(category.categoryId, sub.subcategoryId)
            );

        let toScrape: SubcategoryNode[] = [];
        let scrapeParentOnly = false;

        if (subs.length === 0) {
            scrapeParentOnly = true;
        } else {
            const filteredNames = await filterSubcategoriesByGuidance(
                category.name,
                subs.map((s) => s.name)
            );
            toScrape = subs.filter((s) => filteredNames.includes(s.name));
            shuffle(toScrape);
        }

        if (scrapeParentOnly) {
            const lastCount = categoryCounts.get(category.categoryId) ?? null;
            if (lastCount !== null && lastCount === category.count) {
                console.log(
                    `[${tabLabel}] Skipping category "${category.name}": count unchanged (${category.count}).`
                );
                continue;
            }
            if (
                shouldSkipPartsAndAccessoriesBucket(
                    category.name,
                    category.count
                )
            ) {
                console.log(
                    `[${tabLabel}] Skipping category "${category.name}": parts+accessories, ${category.count} items (>800).`
                );
                continue;
            }
            const count = await getTotalCount(page);
            const unseenCount = Object.keys(unseenItems).length;
            const budget =
                maxItemsForTab != null
                    ? Math.max(0, maxItemsForTab - unseenCount)
                    : undefined;
            const newItems = await collectUnseenItemsInTab({
                ...options,
                totalCount: count,
                maxItemsForTab: budget,
            });
            unseenItems = { ...unseenItems, ...newItems };

            pendingCategoryUpdates.push({
                categoryId: category.categoryId,
                subcategoryId: null,
                count: category.count,
                name: category.name,
            });
            continue;
        }

        for (const subcategory of toScrape) {
            if (
                maxItemsForTab != null &&
                Object.keys(unseenItems).length >= maxItemsForTab
            )
                break;
            const categoryKey = formatCategoryKey(
                category.categoryId,
                subcategory.subcategoryId
            );
            const lastCount = categoryCounts.get(categoryKey) ?? null;
            if (lastCount !== null && lastCount === subcategory.count) {
                console.log(
                    `[${tabLabel}] Skipping subcategory "${category.name} > ${subcategory.name}": count unchanged (${subcategory.count}).`
                );
                continue;
            }
            if (
                shouldSkipPartsAndAccessoriesBucket(
                    subcategory.name,
                    subcategory.count
                )
            ) {
                console.log(
                    `[${tabLabel}] Skipping subcategory "${category.name} > ${subcategory.name}": parts+accessories, ${subcategory.count} items (>800).`
                );
                continue;
            }
            console.log(
                `[${tabLabel}] Subcategory: ${category.name} > ${subcategory.name}`
            );
            await delayBeforeSubcategory();
            const subUrl = `${VINE_URL}?queue=encore&pn=${category.categoryId}&cn=${subcategory.subcategoryId}`;
            await page.goto(subUrl, {
                waitUntil: "domcontentloaded",
                timeout: 20000,
            });
            await delayAfterSubcategory();
            const count = await getTotalCount(page);

            const unseenCount = Object.keys(unseenItems).length;
            const budget =
                maxItemsForTab != null
                    ? Math.max(0, maxItemsForTab - unseenCount)
                    : undefined;
            const newItems = await collectUnseenItemsInTab({
                ...options,
                totalCount: count,
                maxItemsForTab: budget,
            });
            unseenItems = { ...unseenItems, ...newItems };

            pendingCategoryUpdates.push({
                categoryId: category.categoryId,
                subcategoryId: subcategory.subcategoryId,
                count: subcategory.count,
                name: subcategory.name,
            });
        }
    }

    console.log(
        `[${tabLabel}] Smart collection done: ${
            Object.keys(unseenItems).length
        } unseen item(s).`
    );
    return {
        unseenItems,
        pendingCategoryUpdates,
        seenCategoryKeys,
        visitedCategoryIds,
    };
}

/** Paginate through current tab and collect all items. Dedupes by ASIN (first wins). Stops when a page has no unseen items (per getSeenAsins) or when maxItemsForTab reached. Calls onPageProcessed with unseen items from each page. Returns items keyed by ASIN (uppercase). */
async function collectUnseenItemsInTab(
    options: CollectUnseenItemsOptions
): Promise<Record<string, VineItem>> {
    const { page, tab, totalCount, maxItemsForTab, getSeenAsins, onPageProcessed } = options;
    let allItemsByAsin: Record<string, VineItem> = {};

    const maxFromPagination = await getMaxPageFromPagination(page);
    const maxFromCount = Math.ceil(totalCount / 24) || 1;
    const maxPages = Math.min(500, maxFromPagination || maxFromCount);
    if (maxFromPagination > 0) {
        console.log(
            `[pagination] Tab "${tab}": pagination shows ${maxFromPagination} page(s); will fetch up to ${maxPages}.`
        );
    }
    if (maxItemsForTab != null && maxItemsForTab > 0) {
        console.log(
            `[pagination] Tab "${tab}": cap at ${maxItemsForTab} item(s) for this tab.`
        );
    }

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
        if (pageNum > 0) {
            console.log(
                `[pagination] Tab "${tab}": changing to page ${pageNum + 1}...`
            );
            const moved = await goToNextPage(page);
            if (!moved) {
                console.log(
                    `[pagination] Tab "${tab}": no more pages (could not go to page ${
                        pageNum + 1
                    }).`
                );
                break;
            }
            console.log(
                `[pagination] Tab "${tab}": now on page ${pageNum + 1}.`
            );
        } else {
            console.log(
                `[pagination] Tab "${tab}": on page 1 (of up to ${maxPages}).`
            );
        }

        const pageItems = await extractItemsFromPage(page, tab);

        if (getSeenAsins != null) {
            const pageAsins = Object.keys(pageItems);
            const seenAsins = await getSeenAsins(pageAsins);

            console.log(
                `[pagination] Tab "${tab}" page ${pageNum + 1}: ${
                    pageAsins.length
                } item(s), ${seenAsins.size} seen.`
            );
            seenAsins.forEach((a) => delete pageItems[a]);
        }

        allItemsByAsin = { ...allItemsByAsin, ...pageItems };
        const unseenAsinCount = Object.keys(pageItems).length;

        if (onPageProcessed != null && unseenAsinCount > 0) {
            await onPageProcessed(Object.values(pageItems));
        }

        if (unseenAsinCount === 0) {
            console.log(
                `[pagination] Tab "${tab}": no more pages (all items already seen, escape).`
            );
            break;
        }

        if (maxItemsForTab != null && unseenAsinCount >= maxItemsForTab) {
            console.log(
                `[pagination] Tab "${tab}": hit cap (${maxItemsForTab}); stopping.`
            );
            break;
        }
    }

    const allAsinsCount = Object.keys(allItemsByAsin).length;
    console.log(
        `[pagination] Tab "${tab}": done, ${allAsinsCount} item(s) collected.`
    );
    return allItemsByAsin;
}

export interface ScraperResult {
    tabCounts: TabCounts;
    /** Items per tab, keyed by ASIN (uppercase). */
    itemsByTab: Record<VineTabId, Record<string, VineItem>>;
    /** All items from this scan, keyed by ASIN (uppercase). One entry per ASIN. */
    unseenItems: Record<string, VineItem>;
    /** Commit only after notification is sent (Additional tab smart flow). */
    pendingCategoryUpdates?: PendingCategoryUpdate[];
    seenCategoryKeys?: Set<string>;
    visitedCategoryIds?: Set<string>;
}

export interface ScraperOptions {
    /** Stop collecting when total items across tabs reaches this (enforces AI max per run). */
    maxItems: number;
    /** Optional: return the subset of desired ASINs that have been seen (e.g. in DB). Used for pagination escape when all items on a page are seen. */
    getSeenAsins?: (desired: string[]) => Promise<Set<string>>;
    /** Optional: called when a batch of new items is loaded (and at the end if any remain in the queue). Receives the batch; may return appealing ASINs to accumulate. */
    onBatchProcessed?: (items: VineItem[]) => Promise<void>;
    /** Batch size for onBatchProcessed (only used when onBatchProcessed is set). New items are queued and sent in batches of this size. */
    batchSize?: number;
}

/** Run full scrape: sign in, then for each tab get count and collect items. When onBatchProcessed is set, it is called as each batch of new items is loaded and at the end for any remainder. */
export async function runScraper(
    browser: Browser,
    options: ScraperOptions
): Promise<ScraperResult> {
    const {
        maxItems: maxItemsForRun = Infinity,
        getSeenAsins,
        onBatchProcessed,
        batchSize: batchSizeOpt,
    } = options;
    const batchSize =
        onBatchProcessed != null && batchSizeOpt != null && batchSizeOpt > 0
            ? batchSizeOpt
            : 0;
    const pendingNewItems: VineItem[] = [];
    let totalNewQueued = 0;
    const maxNewToScore = maxItemsForRun;

    const onPageProcessed =
        onBatchProcessed != null && batchSize > 0
            ? async (items: VineItem[]) => {
                  const remaining = Math.max(0, maxNewToScore - totalNewQueued);
                  const toQueue = items.slice(0, remaining);
                  totalNewQueued += toQueue.length;
                  pendingNewItems.push(...toQueue);
                  while (pendingNewItems.length >= batchSize) {
                      const batch = pendingNewItems.splice(0, batchSize);
                      await onBatchProcessed(batch);
                  }
              }
            : undefined;

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    try {
        await page.goto(VINE_URL, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });
        await wait(3000);

        const needsSignIn =
            page.url().includes("ap/signin") ||
            page.url().includes("signin") ||
            (await page.$(EMAIL_SELECTORS)) != null;
        if (needsSignIn) {
            await signInOnCurrentPage(page);
            await page.goto(VINE_URL, {
                waitUntil: "domcontentloaded",
                timeout: 60000,
            });
            await wait(3000);
            if (
                page.url().includes("ap/signin") ||
                (await page.$(EMAIL_SELECTORS))
            ) {
                console.warn(
                    "Still on sign-in page. Complete login in the browser (e.g. captcha, 2FA). Waiting 90s for you to finish…"
                );
                if (process.stdin.isTTY) {
                    console.warn("Or press Enter in this terminal when done.");
                    await Promise.race([
                        new Promise<void>((r) =>
                            process.stdin.once("data", () => r())
                        ),
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
        const itemsByTab: Record<VineTabId, Record<string, VineItem>> = {
            recommended: {},
            available: {},
            additional: {},
        };

        let pendingCategoryUpdates: PendingCategoryUpdate[] = [];
        let seenCategoryKeys: Set<string> = new Set();
        let visitedCategoryIds: Set<string> = new Set();

        let allItemsByAsin: Record<string, VineItem> = {};
        for (const tab of [
            "recommended",
            "available",
            "additional",
        ] as VineTabId[]) {
            const count = await openTabAndGetCount(page, tab);
            tabCounts[tab] = count;
            if (count > 0) {
                const maxItemsThisTab = Math.max(
                    0,
                    maxItemsForRun - Object.keys(allItemsByAsin).length
                );
                let smartResult: {
                    unseenItems: Record<string, VineItem>;
                    pendingCategoryUpdates: PendingCategoryUpdate[];
                    seenCategoryKeys: Set<string>;
                    visitedCategoryIds: Set<string>;
                } | null = null;
                const collectOptions: CollectUnseenItemsOptions = {
                    page,
                    tab,
                    totalCount: count,
                    maxItemsForTab: maxItemsThisTab,
                    getSeenAsins,
                    onPageProcessed,
                };
                const tabUnseenItems =
                    tab === "recommended"
                        ? await collectUnseenItemsInTab(collectOptions)
                        : ((smartResult = await collectUnseenItemsSmart(
                              collectOptions
                          )),
                          smartResult.unseenItems);
                itemsByTab[tab] = tabUnseenItems;
                allItemsByAsin = { ...allItemsByAsin, ...tabUnseenItems };

                if (smartResult) {
                    pendingCategoryUpdates.push(
                        ...smartResult.pendingCategoryUpdates
                    );
                    for (const k of smartResult.seenCategoryKeys)
                        seenCategoryKeys.add(k);
                    for (const id of smartResult.visitedCategoryIds)
                        visitedCategoryIds.add(id);
                }
            }
        }

        if (onBatchProcessed != null && pendingNewItems.length > 0) {
            await onBatchProcessed(pendingNewItems);
        }

        return {
            tabCounts,
            itemsByTab,
            unseenItems: allItemsByAsin,
            pendingCategoryUpdates,
            seenCategoryKeys,
            visitedCategoryIds,
        };
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
        await page.goto(VINE_URL, {
            waitUntil: "domcontentloaded",
            timeout: 60000,
        });
        await wait(3000);

        const needsSignIn =
            page.url().includes("ap/signin") ||
            page.url().includes("signin") ||
            (await page.$(EMAIL_SELECTORS)) != null;
        if (needsSignIn) {
            await signInOnCurrentPage(page);
            await page.goto(VINE_URL, {
                waitUntil: "domcontentloaded",
                timeout: 60000,
            });
            await wait(3000);
        }

        const tabCounts: TabCounts = {
            recommended: 0,
            available: 0,
            additional: 0,
        };

        for (const tab of [
            "recommended",
            "available",
            "additional",
        ] as VineTabId[]) {
            tabCounts[tab] = await openTabAndGetCount(page, tab);
        }

        return tabCounts;
    } finally {
        await page.close();
    }
}
