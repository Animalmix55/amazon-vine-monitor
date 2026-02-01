import { clearDb, closeDb } from "./db.js";

async function main(): Promise<void> {
  await clearDb();
  console.log("DB cleared (vine_items + meta).");
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
