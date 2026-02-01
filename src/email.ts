import nodemailer from "nodemailer";
import { config } from "./config.js";
import type { VineItem } from "./types.js";

const VINE_ITEMS_URL = "https://www.amazon.com/vine/vine-items";

function buildHtml(items: VineItem[]): string {
  const rows = items
    .map(
      (it) => `
    <tr>
      <td style="padding:12px; border-bottom:1px solid #eee; vertical-align:top;">
        ${it.imageUrl ? `<img src="${escapeHtml(it.imageUrl)}" alt="" width="120" height="120" style="object-fit:contain; margin-right:12px; float:left;" />` : ""}
        <div>
          <a href="${escapeHtml(it.link)}" style="font-size:16px; color:#007185;">${escapeHtml(it.name)}</a>
          <br/>
          <a href="${escapeHtml(it.link)}" style="font-size:12px; color:#0066c0;">View on Amazon</a>
        </div>
      </td>
    </tr>`
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Vine recommendations</title></head>
<body style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto;">
  <h2>Amazon Vine – items you might like</h2>
  <p>These items matched your preferences from this scan.</p>
  <p><a href="${VINE_ITEMS_URL}" style="color:#0066c0;">Open Amazon Vine →</a></p>
  <table style="width:100%; border-collapse: collapse;">
    ${rows}
  </table>
  <p style="margin-top:24px; font-size:12px; color:#666;">
    <a href="${VINE_ITEMS_URL}">Amazon Vine</a> | Sent by Vine Monitor
  </p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Send one batched email for this scan with all appealing items. */
export async function sendBatchedRecommendation(items: VineItem[]): Promise<void> {
  if (items.length === 0) return;

  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  const html = buildHtml(items);
  await transporter.sendMail({
    from: `Vine Monitor <${config.notificationSender}>`,
    to: config.notificationReceiver,
    subject: `Amazon Vine: ${items.length} item(s) you might like`,
    html,
    text: items.map((it) => `${it.name}\n${it.link}`).join("\n\n"),
  });
}
