import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { handleMessage, type ChatResult, type Conversation } from "./agent/core";
import { demoDriver } from "./agent/demoDriver";
import { liveDriver } from "./agent/liveDriver";
import { newContext } from "./agent/tools";
import { SampleBackend } from "./store/sample";
import type { SampleStore } from "./store/types";

/**
 * npm run eval            -> demo driver (no API key; checks tools, guards and wiring)
 * ANTHROPIC_API_KEY=… npm run eval -> live Claude, same cases (costs a few cents)
 * Writes evals/results-<mode>.json with every reply so misses can be read, not just counted.
 */

interface Case {
  id: string;
  turns: string[];
  tools: string[];
  must?: string[];
  mustNot?: string[];
  handoff?: boolean;
  products?: boolean;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "data", "sample-store.json"), "utf8")) as SampleStore;
const { cases } = JSON.parse(readFileSync(join(root, "evals", "cases.json"), "utf8")) as { cases: Case[] };
const live = !!process.env.ANTHROPIC_API_KEY;
const driver = live ? liveDriver(data.shop.name) : demoDriver;

function grade(c: Case, results: ChatResult[]): string[] {
  const last = results[results.length - 1];
  const called = new Set(results.flatMap((r) => r.steps.map((s) => s.tool)));
  const fails: string[] = [];
  for (const t of c.tools) if (!called.has(t)) fails.push(`did not call ${t}`);
  for (const re of c.must ?? []) if (!new RegExp(re, "i").test(last.message)) fails.push(`reply lacks /${re}/`);
  for (const re of c.mustNot ?? []) if (new RegExp(re).test(last.message)) fails.push(`reply contains /${re}/`);
  if (c.handoff !== undefined && !!last.handoff !== c.handoff) fails.push(c.handoff ? "no handoff" : "unexpected handoff");
  if (c.products === true && !last.products.length) fails.push("no product cards");
  if (c.products === false && last.products.length) fails.push("unexpected product cards");
  if (results.some((r) => r.blocked.length)) fails.push(`guard blocked a draft: ${results.flatMap((r) => r.blocked).join("; ")}`);
  return fails;
}

const rows = [];
let passed = 0;
for (const c of cases) {
  const conv: Conversation = { ctx: newContext(new SampleBackend(data), () => undefined, data.shop.lowStockThreshold, () => new Date(`${data.shop.today}T12:00:00Z`)), history: [], driverState: {} };
  const results: ChatResult[] = [];
  const started = Date.now();
  for (const t of c.turns) results.push(await handleMessage(conv, driver, t));
  const fails = grade(c, results);
  if (!fails.length) passed++;
  rows.push({ id: c.id, pass: !fails.length, fails, ms: Date.now() - started, reply: results[results.length - 1].message, tools: results.flatMap((r) => r.steps.map((s) => s.tool)) });
  console.log(`${fails.length ? "FAIL" : "pass"}  ${c.id}${fails.length ? "  — " + fails.join("; ") : ""}`);
}

const mode = live ? "live" : "demo";
const out = { mode, model: live ? process.env.LLM_MODEL || "claude-opus-5-5" : null, ranAt: new Date().toISOString(), passed, total: cases.length, rows };
writeFileSync(join(root, "evals", `results-${mode}.json`), JSON.stringify(out, null, 2));
console.log(`\n${mode} mode: ${passed}/${cases.length} cases passed`);
