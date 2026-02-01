import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { config } from "./config.js";
import type { VineItem } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDANCE_PATH = join(__dirname, "..", "guidance.md");

function loadGuidance(): string {
  const path = join(process.cwd(), "guidance.md");
  if (existsSync(path)) {
    return readFileSync(path, "utf-8");
  }
  if (existsSync(GUIDANCE_PATH)) {
    return readFileSync(GUIDANCE_PATH, "utf-8");
  }
  return "Consider items appealing if they seem useful, high quality, or interesting. Avoid junk, redundant, or low-value items.";
}

/** Returns true if OpenAI is configured. */
export function hasOpenAI(): boolean {
  return Boolean(config.openai.apiKey?.trim());
}

/**
 * Prompt sent to OpenAI (per batch):
 *
 * SYSTEM:
 *   "You are a filter for Amazon Vine product recommendations. Use the following guidance
 *    to decide which items the user would find appealing. Reply with a JSON array of ASINs
 *    (the 10-character IDs in brackets) that are appealing—nothing else.
 *
 *    Guidance from the user:
 *    <full contents of guidance.md>"
 *
 * USER:
 *   "From this list, which product ASINs are appealing according to the guidance?
 *    Reply only with a JSON array of those ASINs, e.g. [\"B0ABC12345\",\"B0XYZ67890\"]
 *
 *    - [ASIN1] Product name one
 *    - [ASIN2] Product name two
 *    ..."
 *
 * Tokens per request (worst case, ~4 chars/token):
 *   System:  ~50 (fixed) + guidance.md → e.g. 550 if guidance is 2k chars.
 *   User:    ~30 (fixed) + (batchSize × ~25) per line → e.g. 30 + 500×25 ≈ 12,530 for max batch 500.
 *   Output:  JSON array of ASINs → up to ~batchSize × 4 (e.g. ~2k for 500 ASINs).
 *   gpt-4o-mini context is 128k; max batch 500 stays well under that.
 *
 * Per scan: at most ceil(aiMaxItemsPerRun / aiBatchSize) requests (e.g. 500/50 = 10, or 500/500 = 1).
 */
export async function scoreAppeal(items: VineItem[]): Promise<string[]> {
  if (items.length === 0) return [];

  const guidance = loadGuidance();

  if (!hasOpenAI()) {
    console.warn("No OPENAI_API_KEY set; treating all new items as not appealing (no emails). Set key and guidance.md for AI filtering.");
    return [];
  }

  const openai = new OpenAI({ apiKey: config.openai.apiKey });
  const batchSize = config.aiBatchSize;
  const maxItems = config.aiMaxItemsPerRun;
  const toScore = items.slice(0, maxItems);
  if (items.length > maxItems) {
    console.warn(`Capping OpenAI scoring at ${maxItems} items (${items.length - maxItems} not scored). Set AI_MAX_ITEMS_PER_RUN to change.`);
  }
  const appealing: string[] = [];

  for (let i = 0; i < toScore.length; i += batchSize) {
    const batch = toScore.slice(i, i + batchSize);
    const list = batch
      .map((it) => `- [${it.asin}] ${it.name}`)
      .join("\n");

    const sys = `You are a filter for Amazon Vine product recommendations. Use the following guidance to decide which items the user would find appealing. Reply with a JSON array of ASINs (the 10-character IDs in brackets) that are appealing—nothing else.

Guidance from the user:
${guidance}`;

    const user = `From this list, which product ASINs are appealing according to the guidance? Reply only with a JSON array of those ASINs, e.g. ["B0ABC12345","B0XYZ67890"]\n\n${list}`;

    try {
      const res = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      });
      const usage = res.usage;
      if (usage) {
        console.log(`OpenAI batch ${Math.floor(i / batchSize) + 1}: ${usage.prompt_tokens} in, ${usage.completion_tokens} out`);
      }
      const content = res.choices[0]?.message?.content?.trim();
      if (!content) continue;
      let asins: string[] = [];
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) asins = parsed;
        else if (parsed && typeof parsed === "object") asins = parsed.asins ?? parsed.appealing ?? Object.values(parsed).flat();
      } catch {
        const match = content.match(/\[[\s\S]*?\]/);
        if (match) asins = JSON.parse(match[0]);
      }
      const valid = batch.map((it) => it.asin);
      for (const a of asins) {
        const asin = String(a).toUpperCase().trim();
        if (asin.length === 10 && valid.includes(asin)) appealing.push(asin);
      }
    } catch (e) {
      console.error("OpenAI appeal scoring error:", e);
    }
  }

  return appealing;
}

/**
 * Given a top-level category name and list of subcategory names, use guidance.md
 * to return which subcategories the user would find appealing (so we only scrape those).
 * Returns the subset of subcategory names to scrape; if OpenAI is unavailable, returns all.
 */
export async function filterSubcategoriesByGuidance(
  category: string,
  subcategoryNames: string[]
): Promise<string[]> {
  if (subcategoryNames.length === 0) return [];

  const guidance = loadGuidance();
  if (!hasOpenAI()) {
    console.warn("No OPENAI_API_KEY set; scraping all subcategories under " + category);
    return subcategoryNames;
  }

  const openai = new OpenAI({ apiKey: config.openai.apiKey });
  const list = subcategoryNames.map((n) => `- ${n}`).join("\n");

  const sys = `You are a filter for Amazon Vine category preferences. The user has guidance for which kinds of products they like. Given a top-level category and its subcategories, reply with a JSON array of the subcategory NAMES that match the user's interests—only those they would want to browse. Reply with nothing else.

Guidance from the user:
${guidance}`;

  const user = `Top-level category: "${category}"

Subcategories:
${list}

Which of these subcategory names (exact names only) would the user find appealing to browse, given their guidance? Reply only with a JSON array of those names, e.g. ["Replacement Parts","Tools & Equipment"]. Include only names from the list above.`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    });
    const content = res.choices[0]?.message?.content?.trim();
    if (!content) return subcategoryNames;

    let names: string[] = [];
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) names = parsed.map(String);
      else if (parsed && typeof parsed === "object") names = parsed.subcategories ?? parsed.names ?? Object.values(parsed).flat();
    } catch {
      const match = content.match(/\[[\s\S]*?\]/);
      if (match) names = JSON.parse(match[0]);
    }

    const validSet = new Set(subcategoryNames.map((n) => n.trim()));
    const filtered = names.filter((n) => validSet.has(String(n).trim()));
    if (filtered.length > 0) {
      console.log(`[AI] Under "${category}": scraping ${filtered.length} of ${subcategoryNames.length} subcategories: ${filtered.join(", ")}`);
    }
    return filtered.length > 0 ? filtered : subcategoryNames;
  } catch (e) {
    console.error("OpenAI subcategory filter error:", e);
    return subcategoryNames;
  }
}
