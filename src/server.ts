import { appendFileSync, readFileSync } from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { handleMessage, type AgentDriver, type Conversation } from "./agent/core";
import { demoDriver } from "./agent/demoDriver";
import { redactPII } from "./agent/guards";
import { liveDriver, PROMPT_VERSION } from "./agent/liveDriver";
import { newContext, type HandoffTicket } from "./agent/tools";
import { MockShopBackend, ShopifyAdminBackend } from "./store/shopify";
import { SampleBackend } from "./store/sample";
import type { SampleStore, StoreBackend } from "./store/types";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(readFileSync(join(root, "data", "sample-store.json"), "utf8")) as SampleStore;

export function createBackend(): StoreBackend {
  switch (process.env.STORE_BACKEND || "sample") {
    case "shopify": {
      const { SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, SHOPIFY_API_VERSION } = process.env;
      if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) throw new Error("STORE_BACKEND=shopify needs SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN");
      // Sizing / warranty / wholesale / discount texts have no Shopify policy type; keep them in a file the merchant edits.
      const extra = { sizing: sample.policies.sizing, warranty: sample.policies.warranty, wholesale: sample.policies.wholesale, discounts: sample.policies.discounts };
      return new ShopifyAdminBackend(SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN, SHOPIFY_API_VERSION || "2026-10", extra);
    }
    case "mockshop":
      return new MockShopBackend(sample);
    default:
      return new SampleBackend(sample);
  }
}

const store = createBackend();
const driver: AgentDriver = process.env.ANTHROPIC_API_KEY ? liveDriver(sample.shop.name) : demoDriver;

async function onHandoff(t: HandoffTicket) {
  appendFileSync(join(root, "data", "handoffs.jsonl"), JSON.stringify(t) + "\n");
  if (process.env.HANDOFF_WEBHOOK_URL) {
    await fetch(process.env.HANDOFF_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: `New support handoff ${t.ticketId} (${t.reason}): ${t.summary}`, ticket: t }) }).catch(() => undefined);
  }
}

// In-memory sessions with a 30-minute idle timeout. One process is enough for a small store;
// swap for Redis when running several instances.
const sessions = new Map<string, Conversation & { lastSeen: number }>();
const SESSION_TTL = 30 * 60_000;
function session(id: string | undefined) {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.lastSeen > SESSION_TTL) sessions.delete(k);
  const key = id && /^[\w-]{8,64}$/.test(id) ? id : randomUUID();
  let s = sessions.get(key);
  if (!s) {
    s = { ctx: newContext(store, onHandoff, sample.shop.lowStockThreshold), history: [], driverState: {}, lastSeen: now };
    sessions.set(key, s);
  }
  s.lastSeen = now;
  return { key, conv: s };
}

// Simple fixed-window limit per client: 20 messages / 5 minutes.
const hits = new Map<string, { n: number; since: number }>();
function limited(client: string) {
  const now = Date.now();
  const h = hits.get(client);
  if (!h || now - h.since > 5 * 60_000) {
    hits.set(client, { n: 1, since: now });
    return false;
  }
  return ++h.n > 20;
}

/**
 * Shopify app proxy signature: HMAC-SHA256 (hex) of the sorted query params, each as `key=value`
 * (array values joined with ","), concatenated with no separator, keyed with the app's client secret.
 */
export function verifyAppProxy(query: Record<string, unknown>, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const { signature, ...rest } = query;
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? (rest[k] as string[]).join(",") : String(rest[k])}`)
    .join("");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  const ts = Number(rest.timestamp);
  return ok && Number.isFinite(ts) && Math.abs(nowSec - ts) < 300;
}

async function chat(req: express.Request, res: express.Response) {
  const client = String(req.query.logged_in_customer_id || req.ip);
  if (limited(client)) return res.status(429).json({ error: "Too many messages. Please wait a few minutes." });
  const text = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 1000) : "";
  if (!text) return res.status(400).json({ error: "Empty message" });

  const { key, conv } = session(req.body?.sessionId);
  const started = Date.now();
  const result = await handleMessage(conv, driver, text);
  appendFileSync(
    join(root, "data", "chat-log.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      session: key,
      mode: result.mode,
      promptVersion: PROMPT_VERSION,
      latencyMs: Date.now() - started,
      question: redactPII(text),
      reply: redactPII(result.message),
      tools: result.steps.map((s) => s.tool),
      blocked: result.blocked,
      handoff: result.handoff?.ticketId ?? null,
    }) + "\n",
  );
  // Tool outputs stay on the server; the widget gets the reply, product cards and (in dev) the step names.
  res.json({ sessionId: key, message: result.message, products: result.products, handoff: result.handoff ? { ticketId: result.handoff.ticketId } : null, steps: result.steps.map((s) => ({ tool: s.tool, summary: s.summary })), mode: result.mode });
}

export const app = express();
app.use(express.json({ limit: "16kb" }));

// Storefront traffic arrives through the Shopify app proxy (/apps/support/* on the store's domain).
app.post("/proxy/chat", (req, res, next) => {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret || !verifyAppProxy(req.query as Record<string, unknown>, secret)) return res.status(401).json({ error: "Bad signature" });
  chat(req, res).catch(next);
});

// Local demo page + unsigned endpoint. Disabled in production.
if (process.env.NODE_ENV !== "production") {
  app.post("/api/chat", (req, res, next) => void chat(req, res).catch(next));
  app.get("/widget/support-chat.js", (_req, res) => res.sendFile(join(root, "extensions/support-chat/assets/support-chat.js")));
  app.get("/widget/support-chat.css", (_req, res) => res.sendFile(join(root, "extensions/support-chat/assets/support-chat.css")));
  app.use(express.static(join(root, "public")));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 8790);
  app.listen(port, () => console.log(`Support agent on http://localhost:${port} — ${driver.mode} mode, store backend: ${store.name}`));
}
