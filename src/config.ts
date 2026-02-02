import "dotenv/config";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v == null || v === "") throw new Error(`Missing required env: ${name}`);
  return v;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

export const config = {
  amazon: {
    email: requireEnv("AMAZON_EMAIL"),
    password: requireEnv("AMAZON_PASSWORD"),
  },
  mongodb: {
    uri: optionalEnv("MONGODB_URI", "mongodb://localhost:27017/vine_monitor"),
  },
  openai: {
    apiKey: process.env["OPENAI_API_KEY"] ?? "",
    /** Path for AI request/response log (prompts + results). Set OPENAI_LOG_PATH in .env; default openai.log in cwd. */
    logPath: optionalEnv("OPENAI_LOG_PATH", "openai.log"),
  },
  /** Items per OpenAI request (larger = fewer requests; gpt-4o-mini handles 500+ fine). */
  aiBatchSize: Math.min(500, Math.max(10, parseInt(optionalEnv("AI_BATCH_SIZE", "50"), 10) || 50)),
  /** Max new items to score per scan (caps cost; rest are not marked appealing). */
  aiMaxItemsPerRun: Math.min(2000, Math.max(50, parseInt(optionalEnv("AI_MAX_ITEMS_PER_RUN", "500"), 10) || 500)),
  smtp: {
    host: requireEnv("SMTP_HOST"),
    port: parseInt(optionalEnv("SMTP_PORT", "587"), 10),
    // Port 587 uses STARTTLS (secure: false); 465 uses implicit TLS (secure: true)
    secure: process.env["SMTP_SECURE"] === "true",
    user: requireEnv("SMTP_USER"),
    pass: requireEnv("SMTP_PASS"),
  },
  /** From address (must be verified in SES). */
  notificationSender: requireEnv("NOTIFICATION_SENDER"),
  /** Recipient for Vine recommendation emails (NOTIFICATION_RECEIVER or NOTIFICATION_RECIEVER). */
  notificationReceiver: (() => {
    const r = process.env["NOTIFICATION_RECEIVER"] ?? process.env["NOTIFICATION_RECIEVER"];
    if (!r?.trim()) throw new Error("Missing NOTIFICATION_RECEIVER or NOTIFICATION_RECIEVER");
    return r.trim();
  })(),
  /** Polling window: next check is random between min and max (ms). Default 5–45 min to avoid bot-like regularity. */
  checkIntervalMinMs: parseInt(optionalEnv("CHECK_INTERVAL_MIN_MS", "300000"), 10),
  checkIntervalMaxMs: parseInt(optionalEnv("CHECK_INTERVAL_MAX_MS", "2700000"), 10),
  /** Legacy: if set, overrides min/max to this fixed value. Prefer CHECK_INTERVAL_MIN_MS + CHECK_INTERVAL_MAX_MS. */
  checkIntervalMs: process.env["CHECK_INTERVAL_MS"]
    ? parseInt(process.env["CHECK_INTERVAL_MS"], 10)
    : undefined,
  /** Run browser with a visible window (set HEADLESS=false in .env) */
  headless: optionalEnv("HEADLESS", "true").toLowerCase() !== "false",
} as const;
