/**
 * Browser build for the portfolio playground: the repo's own tools, guards and handoff logic over the
 * sample store, driven by the demo router (no model, no API key, nothing leaves the browser).
 * Build: npm run build:playground  ->  dist/support-playground.js
 */
import { handleMessage, type ChatResult, type Conversation } from "./agent/core";
import { demoDriver } from "./agent/demoDriver";
import { newContext } from "./agent/tools";
import { SampleBackend } from "./store/sample";
import type { SampleStore } from "./store/types";

export function createSession(data: SampleStore) {
  const store = new SampleBackend(data);
  const conv: Conversation = { ctx: newContext(store, () => undefined, data.shop.lowStockThreshold), history: [], driverState: {} };
  return { send: (message: string): Promise<ChatResult> => handleMessage(conv, demoDriver, message) };
}
