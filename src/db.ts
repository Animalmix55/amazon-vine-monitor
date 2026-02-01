import { MongoClient, Collection } from "mongodb";
import { config } from "./config.js";
import type { VineItemRecord, TabCounts } from "./types.js";

const COLLECTION = "vine_items";
const COUNTS_DOC_ID = "last_tab_counts";

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

/** Ensure unique index on asin so we upsert by product. */
export async function ensureIndexes() {
  const col = await getVineCollection();
  await col.createIndex({ asin: 1 }, { unique: true });
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

/** Get all asins we have ever seen (to avoid re-suggesting). */
export async function getSeenAsins(): Promise<Set<string>> {
  const col = await getVineCollection();
  const docs = await col.find({}).project({ asin: 1 }).toArray();
  return new Set(docs.map((d) => d.asin));
}

/** Persist items from a scan; mark which ones were suggested in this batch. */
export async function saveScanItems(
  items: Array<Omit<VineItemRecord, "suggestedAt">>,
  suggestedAsins: string[]
): Promise<void> {
  const suggestedSet = new Set(suggestedAsins);
  for (const item of items) {
    await upsertItem(item, suggestedSet.has(item.asin));
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

/** Clear vine_items and meta (for a clean run). */
export async function clearDb(): Promise<void> {
  const db = await getDb();
  await db.collection(COLLECTION).deleteMany({});
  await db.collection<MetaDoc>("meta").deleteMany({});
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
