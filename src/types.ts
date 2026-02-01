/** Vine tab identifiers matching the UI. */
export type VineTabId = "recommended" | "available" | "additional";

/** Single item as scraped from Vine (one product row). */
export interface VineItem {
  asin: string;
  tab: VineTabId;
  name: string;
  link: string;
  imageUrl: string | null;
  /** When we first saw this item in a scan. */
  seenAt: Date;
}

/** Stored record: item + whether we suggested it and when. */
export interface VineItemRecord {
  asin: string;
  tab: VineTabId;
  name: string;
  link: string;
  imageUrl: string | null;
  seenAt: Date;
  /** If we sent an email recommending this item. */
  suggestedAt: Date | null;
}

/** Counts per tab from a single scan (for detecting increases). */
export interface TabCounts {
  recommended: number;
  available: number;
  additional: number;
}
