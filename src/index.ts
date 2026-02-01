import { join } from "path";
import puppeteer, { Browser } from "puppeteer";
import {
  ensureIndexes,
  getLastTabCounts,
  saveLastTabCounts,
  saveScanItems,
  getSeenAsins,
  closeDb,
} from "./db.js";
import { runScraper, fetchTabCounts } from "./scraper.js";
import { scoreAppeal } from "./ai.js";
import { sendBatchedRecommendation } from "./email.js";
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
  const seen = await getSeenAsins();
  const appealingPromises: Promise<string[]>[] = [];
  const { tabCounts, allItems, remainderNewItems } = await runScraper(browser, {
    maxItems: config.aiMaxItemsPerRun,
    seen,
    batchSize: config.aiBatchSize,
    onBatchNewItems: (batch) => {
      appealingPromises.push(scoreAppeal(batch));
    },
  });
  await saveLastTabCounts(tabCounts);

  if (allItems.length === 0) {
    console.log("No items found this scan.");
    return;
  }

  const newItemsCount = allItems.filter((it) => !seen.has(it.asin)).length;
  if (newItemsCount === 0) {
    console.log("No new items; saving existing items and counts.");
    await saveScanItems(allItems, []);
    return;
  }

  const batchResults = await Promise.all(appealingPromises);
  let appealingAsins = batchResults.flat();
  if (remainderNewItems.length > 0) {
    const remainderAppealing = await scoreAppeal(remainderNewItems);
    appealingAsins = [...appealingAsins, ...remainderAppealing];
  }
  const appealingItems = allItems.filter((it) => appealingAsins.includes(it.asin));
  console.log(`${appealingItems.length} of ${newItemsCount} new item(s) are appealing.`);

  if (appealingItems.length > 0) {
    console.log(`Sending batched email for ${appealingItems.length} appealing item(s).`);
    await sendBatchedRecommendation(appealingItems);
  }

  await saveScanItems(allItems, appealingAsins);
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
