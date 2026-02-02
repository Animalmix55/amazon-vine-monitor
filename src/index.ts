import { join } from "path";
import puppeteer, { Browser } from "puppeteer";
import {
  ensureIndexes,
  getLastTabCounts,
  saveLastTabCounts,
  saveScanItems,
  getSeenAsinsFromBatch,
  setCategoryCount,
  clearCategoryCountsNotIn,
  closeDb,
} from "./db.js";
import { runScraper, fetchTabCounts } from "./scraper.js";
import { scoreAppeal } from "./ai.js";
import { sendBatchedRecommendation } from "./email.js";
import { logRecommendations } from "./recommendationLog.js";
import { config } from "./config.js";
import type { TabCounts, VineItem } from "./types.js";

const isOnce = process.argv.includes("--once");
let browserInstance: Browser | null = null;

function anyCountIncreased(prev: TabCounts | null, curr: TabCounts): boolean {
  if (!prev) return true;
  return (
    curr.recommended > prev.recommended ||
    curr.available > prev.available ||
    curr.additional > prev.additional
  );
}

async function runFullScan(browser: puppeteer.Browser): Promise<void> {
  console.log("Running full Vine scan...");
  const getSeenAsins = (desired: string[]) => getSeenAsinsFromBatch(desired);
  const { tabCounts, allItems, appealingAsins = [], newItemsCount = 0, pendingCategoryUpdates, seenCategoryKeys, visitedCategoryIds } = await runScraper(browser, {
    maxItems: config.aiMaxItemsPerRun,
    getSeenAsins,
    onBatchProcessed: (batch: VineItem[]) => scoreAppeal(batch),
    batchSize: config.aiBatchSize,
  });
  await saveLastTabCounts(tabCounts);

  const allItemsArr = Object.values(allItems);
  if (allItemsArr.length === 0) {
    console.log("No items found this scan.");
    return;
  }

  if (newItemsCount === 0 && appealingAsins.length === 0) {
    console.log("No new items; saving existing items and counts.");
    await saveScanItems(allItemsArr, []);
    return;
  }

  const appealingItems = appealingAsins
    .map((a) => allItems[String(a).toUpperCase().trim()])
    .filter((it): it is VineItem => it != null);
  const missingAsins = appealingAsins.filter(
    (a) => !allItems[String(a).toUpperCase().trim()]
  );
  if (missingAsins.length > 0) {
    console.warn(
      `AI returned ${missingAsins.length} appealing ASIN(s) not in scraped items: ${[...new Set(missingAsins.map((a) => a.toUpperCase()))].join(", ")}`
    );
  }
  console.log(`${appealingItems.length} of ${newItemsCount} new item(s) are appealing (${appealingAsins.length} ASINs from AI).`);

  if (appealingItems.length > 0) {
    await logRecommendations(appealingItems);
    console.log(`Sending batched email for ${appealingItems.length} appealing item(s).`);
    await sendBatchedRecommendation(appealingItems);
  }

  await saveScanItems(allItemsArr, appealingAsins);

  if (pendingCategoryUpdates != null && seenCategoryKeys != null && visitedCategoryIds != null) {
    for (const u of pendingCategoryUpdates) {
      await setCategoryCount(u.categoryId, u.subcategoryId, u.count, u.name);
    }
    await clearCategoryCountsNotIn(seenCategoryKeys, visitedCategoryIds);
  }

  console.log("Scan complete.");
}

async function tick(browser: puppeteer.Browser): Promise<void> {
  try {
    const last = await getLastTabCounts();
    const current = await fetchTabCounts(browser);

    if (anyCountIncreased(last, current)) {
      console.log("Tab count increased; running full scan.");
      await runFullScan(browser);
    } else {
      console.log("No count increase; skipping full scan.");
      await saveLastTabCounts(current);
    }
  } catch (e) {
    console.error("Tick error:", e);
  }
}

async function shutdown(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
  await closeDb();
  process.exit(0);
}

async function main(): Promise<void> {
  await ensureIndexes();
  const userDataDir = join(process.cwd(), ".browser-data");
  const browser = await puppeteer.launch({
    headless: config.headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    userDataDir,
  });
  browserInstance = browser;
  console.log("Browser profile:", userDataDir, "(session reused across runs)");

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    if (isOnce) {
      await runFullScan(browser);
      return;
    }

    const minMs = config.checkIntervalMs ?? config.checkIntervalMinMs;
    const maxMs = config.checkIntervalMs ?? config.checkIntervalMaxMs;
    const nextDelayMs = () =>
      minMs === maxMs ? minMs : minMs + Math.floor(Math.random() * (maxMs - minMs + 1));

    async function scheduleNext(): Promise<void> {
      const delay = nextDelayMs();
      console.log(`Next check in ${Math.round(delay / 60000)} min.`);
      await new Promise((r) => setTimeout(r, delay));
      await tick(browser);
      scheduleNext();
    }
    await tick(browser);
    scheduleNext();
  } finally {
    if (isOnce) {
      await closeDb();
      await browser.close();
      browserInstance = null;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
