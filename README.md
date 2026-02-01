# Amazon Vine Monitor

Node.js (TypeScript) app that scrapes [Amazon Vine](https://www.amazon.com/vine/vine-items), detects new items by watching total result counts at a 5-minute interval, scores appeal using OpenAI and a guidance file, and sends **one batched email per scan** with appealing items (with images and links). Items and suggestion state are stored in MongoDB so you never get duplicate suggestions.

## Features

- **Puppeteer** sign-in and scraping of Vine (Recommended for you, Available for all, Additional items).
- **New-item detection**: every 5 minutes, checks total result counts per tab; only when a count increases does it run a full scan and paginate through results.
- **MongoDB**: stores every item by ASIN (from the product link, e.g. `B0F93HFJBZ`), timestamp, and whether it was suggested via email.
- **AI appeal**: optional [OpenAI](https://platform.openai.com/) integration plus a `guidance.md` file so only items that match your preferences get suggested.
- **Batched email**: one email per scan with item name, image, link to the product, and a quick link to Vine. SMTP credentials and notify address come from `.env`.

## Prerequisites

- Node.js 18+
- Docker (for MongoDB) or a MongoDB instance
- Amazon account (Vine eligible)
- SMTP credentials (e.g. Gmail app password)
- Optional: OpenAI API key for appeal filtering

## Setup

1. **Clone and install**

   ```bash
   cd amazon-vine-monitor
   npm install
   ```

2. **Start MongoDB**

   ```bash
   npm run docker:up
   ```

   Or set `MONGODB_URI` to your own MongoDB.

3. **Environment**

   Copy `.env.example` to `.env` and fill in:

   - `AMAZON_EMAIL` / `AMAZON_PASSWORD` – Vine sign-in
   - `MONGODB_URI` – default `mongodb://localhost:27017/vine_monitor`
   - `SMTP_*` and `NOTIFICATION_SENDER` / `NOTIFICATION_RECEIVER` – for batched recommendation emails
   - `OPENAI_API_KEY` – optional; if missing, no items are marked appealing (no emails)

   Optional: `CHECK_INTERVAL_MS` (default 300000 = 5 minutes).

4. **Guidance**

   Edit `guidance.md` with what you find appealing (categories, what to skip, deal-breakers). The AI uses this to decide which new items to include in the batched email.

## Usage

- **Daemon (5m checks)**  
  ```bash
  npm run dev
  ```
  Or build and run: `npm run build && npm start`.

- **Single full scan** (no interval)  
  ```bash
  npm run scrape
  ```

## Flow

1. On each tick, the app fetches only the current tab counts (lightweight).
2. If any tab’s total count is higher than the last saved counts, it runs a full scrape: sign-in, switch tabs, paginate, collect all items with ASIN, name, link, image.
3. It diffs against MongoDB to get “new” items (never seen before).
4. For new items only, it calls OpenAI with `guidance.md` and gets back which ASINs are appealing.
5. It sends **one** email to `NOTIFICATION_RECEIVER` from `NOTIFICATION_SENDER` with all appealing items (name, image, product link, Vine link).
6. It saves all items to MongoDB and marks which ASINs were suggested so they won’t be suggested again.

**Session reuse:** The browser uses a persistent profile (`.browser-data/`) so cookies and login state are saved between runs. You sign in once; later runs reuse the session and avoid repeated logins (fewer red flags with Amazon).

## Tokens per request (OpenAI, worst case)

Each API call sends one **system** message (role + full `guidance.md`) and one **user** message (instruction + list of `- [ASIN] Product name` lines). Estimates below use ~4 characters per token.

| Part | Worst case |
|------|------------|
| System | ~50 (fixed) + guidance → e.g. **~550** if guidance is 2k chars |
| User fixed | **~30** |
| User list | batchSize × ~25 per line → e.g. **~2,500** for 100 items with long titles |
| **Input total** | **~3,100** (100 items) to **~13k** (500 items) per request |
| Output | JSON array of ASINs → **~400** (100 ASINs) to **~2k** (500 ASINs) |

- Max batch size is **500** (`AI_BATCH_SIZE`); gpt-4o-mini’s 128k context handles it. With `AI_BATCH_SIZE=500` and cap 500, one scan = **1 request**. Default (50 batch, 500 cap) = **10 requests** per scan.
- The app logs `OpenAI batch N: X in, Y out` so you can see actual token usage from the API.

## License

MIT.
