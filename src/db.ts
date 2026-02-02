import { MongoClient, Collection } from "mongodb";
import { config } from "./config.js";
import type { VineItemRecord, TabCounts } from "./types.js";

const COLLECTION = "vine_items";
const COUNTS_DOC_ID = "last_tab_counts";
const CATEGORY_COUNTS_COLLECTION = "category_counts";

let client: MongoClient | null = null;

export async function getDb() {
  if (!client) {
    client = new MongoClient(config.mongodb.uri);
    await client.connect();
  }
  return client.db();
}

export function getVineCollection(): Promise<Collection<VineItemRecord>> {
  return getDb().then((db) => db.collection<VineItemRecord>(COLLECTION));
}

/** Format a category count key: categoryId for category-only, "categoryId|subcategoryId" for subcategory. */
export function formatCategoryKey(categoryId: string, subcategoryId?: string | null): string {
  return subcategoryId == null || subcategoryId === "" ? categoryId : `${categoryId}|${subcategoryId}`;
}

interface SubcategoryCount {
  cn: string;
  name?: string;
  count: number;
}

/** One doc per top-level category; subcategories stored as array. */
interface CategoryCountDoc {
  pn: string;
  /** Category name for reference. */
  name?: string;
  /** Parent-only count (when we scraped the category without a sub). */
  count?: number;
  updatedAt: Date;
  subcategories: SubcategoryCount[];
}

/** Get all stored category/subcategory counts. Key = formatCategoryKey(categoryId, subcategoryId). */
export async function getCategoryCounts(): Promise<Map<string, number>> {
  const db = await getDb();
  const col = db.collection<CategoryCountDoc>(CATEGORY_COUNTS_COLLECTION);
  const docs = await col.find({}).toArray();
  const map = new Map<string, number>();
  for (const d of docs) {
    if (d.count != null) map.set(d.pn, d.count);
    for (const sub of d.subcategories ?? []) {
      map.set(formatCategoryKey(d.pn, sub.cn), sub.count);
    }
  }
  return map;
}

/** Save last-seen item count (and optional name) for a category or subcategory. */
export async function setCategoryCount(
  categoryId: string,
  subcategoryId: string | null | undefined,
  count: number,
  name?: string
): Promise<void> {
  const db = await getDb();
  const col = db.collection<CategoryCountDoc>(CATEGORY_COUNTS_COLLECTION);
  const now = new Date();

  if (subcategoryId == null || subcategoryId === "") {
    await col.updateOne(
      { pn: categoryId },
      {
        $set: { pn: categoryId, count, updatedAt: now, ...(name != null && name !== "" ? { name } : {}) },
        $setOnInsert: { subcategories: [] },
      },
      { upsert: true }
    );
    return;
  }

  const doc = await col.findOne({ pn: categoryId });
  const subs = doc?.subcategories ?? [];
  const existing = subs.find((s) => s.cn === subcategoryId);
  const subEntry = { cn: subcategoryId, count, ...(name != null && name !== "" ? { name } : {}) };
  const newSubs = existing
    ? subs.map((s) => (s.cn === subcategoryId ? subEntry : s))
    : [...subs, subEntry];

  await col.updateOne(
    { pn: categoryId },
    { $set: { pn: categoryId, subcategories: newSubs, updatedAt: now } },
    { upsert: true }
  );
}

/**
 * Remove categories/subcategories not in the given keys (e.g. no longer on page).
 * - Deletes whole category docs whose categoryId is not in seenCategoryKeys.
 * - For categories we visited this scan, sets subcategories to only those in seenCategoryKeys.
 * - For categories we did not visit, clears subcategories to [].
 */
export async function clearCategoryCountsNotIn(
  seenCategoryKeys: Set<string>,
  visitedCategoryIds: Set<string>
): Promise<void> {
  if (seenCategoryKeys.size === 0) return;
  const db = await getDb();
  const col = db.collection<CategoryCountDoc>(CATEGORY_COUNTS_COLLECTION);
  const validCategoryIds = new Set<string>();
  for (const key of seenCategoryKeys) {
    validCategoryIds.add(key.includes("|") ? key.split("|")[0]! : key);
  }

  await col.deleteMany({ pn: { $nin: Array.from(validCategoryIds) } });

  const docs = await col.find({ pn: { $in: Array.from(validCategoryIds) } }).toArray();
  for (const d of docs) {
    const subs = d.subcategories ?? [];
    const kept = visitedCategoryIds.has(d.pn)
      ? subs.filter((s) => seenCategoryKeys.has(formatCategoryKey(d.pn, s.cn)))
      : [];
    if (kept.length !== subs.length) {
      await col.updateOne(
        { pn: d.pn },
        { $set: { subcategories: kept, updatedAt: new Date() } }
      );
    }
  }
}

/** Ensure unique index on asin; category_counts keyed by pn only. */
export async function ensureIndexes() {
  const col = await getVineCollection();
  await col.createIndex({ asin: 1 }, { unique: true });
  const db = await getDb();
  const catCol = db.collection<CategoryCountDoc>(CATEGORY_COUNTS_COLLECTION);
  await catCol.createIndex({ pn: 1 }, { unique: true });
}

/** Upsert item; if it already exists, only update suggestedAt when we send a suggestion. */
export async function upsertItem(
  item: Omit<VineItemRecord, "suggestedAt">,
  suggested: boolean
): Promise<void> {
  const col = await getVineCollection();
  const doc: VineItemRecord = {
    ...item,
    suggestedAt: suggested ? new Date() : null,
  };
  const existing = await col.findOne({ asin: item.asin });
  if (existing) {
    await col.updateOne(
      { asin: item.asin },
      {
        $set: {
          name: doc.name,
          link: doc.link,
          imageUrl: doc.imageUrl,
          seenAt: doc.seenAt,
          ...(suggested ? { suggestedAt: doc.suggestedAt } : {}),
        },
      }
    );
    return;
  }
  await col.insertOne(doc);
}

/** Mark multiple items as suggested (batch email sent). */
export async function markAsSuggested(asins: string[]): Promise<void> {
  if (asins.length === 0) return;
  const col = await getVineCollection();
  await col.updateMany(
    { asin: { $in: asins } },
    { $set: { suggestedAt: new Date() } }
  );
}

/** Check which of these asins we have already suggested. */
export async function getSuggestedAsins(asins: string[]): Promise<Set<string>> {
  if (asins.length === 0) return new Set();
  const col = await getVineCollection();
  const docs = await col
    .find({ asin: { $in: asins }, suggestedAt: { $ne: null } })
    .project({ asin: 1 })
    .toArray();
  return new Set(docs.map((d) => d.asin));
}

/** Get all asins we have ever seen (to avoid re-suggesting). Returns stored case; callers should compare case-insensitively when needed. */
export async function getSeenAsins(): Promise<Set<string>> {
  const col = await getVineCollection();
  const docs = await col.find({}).project({ asin: 1 }).toArray();
  return new Set(docs.map((d) => d.asin));
}

/** For a batch of ASINs, return which ones exist in the collection (uppercase). Use this instead of getSeenAsins() when you only need to check specific ASINs. */
export async function getSeenAsinsFromBatch(desired: string[]): Promise<Set<string>> {
  if (desired.length === 0) return new Set();
  const upper = [...new Set(desired.map((a) => String(a).toUpperCase()))];
  const col = await getVineCollection();
  const docs = await col.find({ asin: { $in: upper } }).project({ asin: 1 }).toArray();
  return new Set(docs.map((d) => d.asin.toUpperCase()));
}

/** Persist items from a scan; mark which ones were suggested in this batch. */
export async function saveScanItems(
  items: Array<Omit<VineItemRecord, "suggestedAt">>,
  suggestedAsins: string[]
): Promise<void> {
  const suggestedSet = new Set(suggestedAsins.map((a) => a.toUpperCase()));
  for (const item of items) {
    await upsertItem(item, suggestedSet.has(item.asin.toUpperCase()));
  }
}

interface MetaDoc {
  _id: string;
  counts?: TabCounts;
  updatedAt?: Date;
}

/** Save last-seen tab counts for increase detection. */
export async function saveLastTabCounts(counts: TabCounts): Promise<void> {
  const db = await getDb();
  const col = db.collection<MetaDoc>("meta");
  await col.updateOne(
    { _id: COUNTS_DOC_ID },
    { $set: { counts, updatedAt: new Date() } },
    { upsert: true }
  );
}

/** Get last-seen tab counts; null if never run. */
export async function getLastTabCounts(): Promise<TabCounts | null> {
  const db = await getDb();
  const doc = await db.collection<MetaDoc>("meta").findOne({ _id: COUNTS_DOC_ID });
  return doc?.counts ?? null;
}

/** Clear vine_items, meta, and category_counts (for a clean run). */
export async function clearDb(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).deleteMany({});
  await db.collection<MetaDoc>("meta").deleteMany({});
  await db.collection(CATEGORY_COUNTS_COLLECTION).deleteMany({});
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
