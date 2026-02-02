import { appendFile } from "fs/promises";
import { join } from "path";
import type { VineItem } from "./types.js";

const LOG_FILE = "recommendations.log";

/**
 * Append appealing items to a log file so recommendations are recorded even if email fails.
 * Writes to recommendations.log in the project root (process.cwd()).
 */
export async function logRecommendations(items: VineItem[]): Promise<void> {
  if (items.length === 0) return;
  const path = join(process.cwd(), LOG_FILE);
  const now = new Date().toISOString();
  const header = `\n--- ${now} (${items.length} appealing item(s)) ---\n`;
  const lines = items.map((it) => `- [${it.asin}] ${it.name}\n  ${it.link}`).join("\n");
  const block = header + lines + "\n";
  try {
    await appendFile(path, block, "utf-8");
    console.log(`Recommendations logged to ${path}`);
  } catch (e) {
    console.error("Failed to write recommendations log:", e);
  }
}
