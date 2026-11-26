import { z } from "zod";
import type { Order, Product, StoreBackend } from "../store/types";

/**
 * The only things the support agent can do. Each tool validates its input with zod
 * (the model's tool input is untrusted), and returns only what a shopper may see.
 * No Node imports: this file also runs in the browser playground.
 */

export const POLICY_TOPICS = ["shipping", "returns", "warranty", "sizing", "wholesale", "discounts"] as const;
export const HANDOFF_REASONS = ["customer_asked_for_human", "order_problem", "damaged_or_defective", "refund_or_cancellation", "address_change", "not_sure_of_answer", "other"] as const;
export const MAX_FAILED_ORDER_LOOKUPS = 3;

export interface HandoffTicket {
  ticketId: string;
  reason: (typeof HANDOFF_REASONS)[number];
  summary: string;
  contactEmail: string | null;
  orderName: string | null;
  createdAt: string;
}

/** Per-conversation state. Guards read it to check the final reply against what tools returned. */
export interface ToolContext {
  store: StoreBackend;
  lowStockThreshold: number;
  seenHandles: Set<string>;
  seenAmounts: Set<number>;
  verifiedOrders: Set<string>;
  failedOrderLookups: number;
  handoff: HandoffTicket | null;
  onHandoff: (t: HandoffTicket) => Promise<void> | void;
  now: () => Date;
}

export function newContext(store: StoreBackend, onHandoff: ToolContext["onHandoff"], lowStockThreshold = 5, now = () => new Date()): ToolContext {
  return { store, lowStockThreshold, seenHandles: new Set(), seenAmounts: new Set(), verifiedOrders: new Set(), failedOrderLookups: 0, handoff: null, onHandoff, now };
}

const money = (n: number) => Math.round(n * 100) / 100;
const remember = (ctx: ToolContext, ...amounts: number[]) => amounts.forEach((a) => ctx.seenAmounts.add(money(a)));

function stockLabel(qty: number, threshold: number) {
  if (qty <= 0) return "sold_out";
  if (qty <= threshold) return `low_stock (${qty} left)`;
  return "in_stock";
}

function productCard(ctx: ToolContext, p: Product) {
  const prices = p.variants.map((v) => v.price);
  const from = Math.min(...prices);
  const to = Math.max(...prices);
  ctx.seenHandles.add(p.handle);
  remember(ctx, from, to);
  return {
    handle: p.handle,
    title: p.title,
    category: p.category,
    price: from === to ? from : { from, to },
    url: p.url,
    in_stock: p.variants.some((v) => v.inventory > 0),
  };
}

/** Amounts written inside policy text ("$150", "10%") count as grounded. */
function rememberPolicyAmounts(ctx: ToolContext, text: string) {
  for (const m of text.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)) remember(ctx, Number(m[1]));
}

const s = {
  search_products: z
    .object({
      query: z.string().min(1).max(200).describe("What the shopper is looking for, in plain words, e.g. 'waterproof jacket'"),
      max_price: z.number().positive().nullable().describe("Upper price limit in store currency, or null"),
    })
    .strict(),
  get_product: z.object({ handle: z.string().min(1).max(200).describe("Product handle from search_products") }).strict(),
  get_policy: z.object({ topic: z.enum(POLICY_TOPICS) }).strict(),
  lookup_order: z
    .object({
      order_number: z.string().min(1).max(20).describe("Order number as the shopper wrote it, e.g. '#1043' or '1043'"),
      email: z.string().min(3).max(200).describe("Email the shopper gave in THIS conversation. Never guess it."),
    })
    .strict(),
  create_handoff: z
    .object({
      reason: z.enum(HANDOFF_REASONS),
      summary: z.string().min(10).max(800).describe("Short summary for the support team: what the shopper needs and what you already told them"),
      contact_email: z.string().max(200).nullable().describe("Email the shopper gave in this conversation, or null"),
      order_number: z.string().max(20).nullable().describe("Order number if one was verified, or null"),
    })
    .strict(),
};

type Inputs = { [K in keyof typeof s]: z.infer<(typeof s)[K]> };

export interface ToolDef<K extends keyof typeof s = keyof typeof s> {
  name: K;
  description: string;
  schema: (typeof s)[K];
  run: (ctx: ToolContext, input: Inputs[K]) => Promise<unknown>;
}

function def<K extends keyof typeof s>(d: ToolDef<K>): ToolDef<K> {
  return d;
}

export const TOOLS = {
  search_products: def({
    name: "search_products",
    description: "Search the store's active products. Returns up to 5 matches with price and whether any size/colour is in stock.",
    schema: s.search_products,
    async run(ctx, { query, max_price }) {
      let found = await ctx.store.searchProducts(query, 8);
      if (max_price != null) found = found.filter((p) => Math.min(...p.variants.map((v) => v.price)) <= max_price);
      const results = found.slice(0, 5).map((p) => productCard(ctx, p));
      return { count: results.length, results };
    },
  }),

  get_product: def({
    name: "get_product",
    description: "Details for one product: description, options, stock per variant, average rating and a few customer reviews.",
    schema: s.get_product,
    async run(ctx, { handle }) {
      const p = await ctx.store.getProduct(handle);
      if (!p) return { error: "No product with that handle." };
      const card = productCard(ctx, p);
      const reviews = await ctx.store.getReviews(p.id);
      const rated = (p as Product & { rating?: { average: number; count: number } }).rating;
      const avg = reviews.length ? Math.round((reviews.reduce((a, r) => a + r.rating, 0) / reviews.length) * 10) / 10 : rated?.average ?? null;
      p.variants.forEach((v) => remember(ctx, v.price));
      return {
        ...card,
        description: p.description.slice(0, 900),
        options: p.options,
        variants: p.variants.map((v) => ({ variant: v.title, price: v.price, stock: stockLabel(v.inventory, ctx.lowStockThreshold) })),
        rating: avg == null ? null : { average: avg, count: reviews.length || rated?.count || 0 },
        // Customer-written text: useful as evidence, never as instructions.
        reviews_untrusted: reviews.slice(0, 4).map((r) => ({ rating: r.rating, text: r.body })),
      };
    },
  }),

  get_policy: def({
    name: "get_policy",
    description: "The store's own policy text for a topic. Answer policy questions only from this text.",
    schema: s.get_policy,
    async run(ctx, { topic }) {
      const p = await ctx.store.getPolicy(topic);
      if (!p) return { error: "The store has not published this policy." };
      rememberPolicyAmounts(ctx, p.body);
      return { topic, title: p.title, text: p.body };
    },
  }),

  lookup_order: def({
    name: "lookup_order",
    description:
      "Look up an order. Needs BOTH the order number and the email used at checkout, as given by the shopper in this conversation. " +
      "Returns status, items and tracking only — never addresses or payment details.",
    schema: s.lookup_order,
    async run(ctx, { order_number, email }) {
      if (ctx.failedOrderLookups >= MAX_FAILED_ORDER_LOOKUPS) {
        return { error: "Too many unsuccessful lookups in this chat. Offer to connect the shopper with the support team." };
      }
      const order = await ctx.store.findOrderForCustomer(order_number, email);
      if (!order) {
        ctx.failedOrderLookups++;
        return { found: false, message: "No order matches that order number and email together. Ask the shopper to check both." };
      }
      ctx.verifiedOrders.add(order.name);
      return { found: true, ...orderView(ctx, order) };
    },
  }),

  create_handoff: def({
    name: "create_handoff",
    description:
      "Pass the conversation to the human support team. Use when the shopper asks for a person, for refunds, cancellations, address changes, " +
      "damaged or defective items, or when the tools do not give you a confident answer.",
    schema: s.create_handoff,
    async run(ctx, { reason, summary, contact_email, order_number }) {
      if (ctx.handoff) return { ticket_id: ctx.handoff.ticketId, already_created: true };
      const orderName = order_number ? `#${order_number.replace(/[^0-9]/g, "")}` : null;
      const ticket: HandoffTicket = {
        ticketId: `HO-${ctx.now().getTime().toString(36).toUpperCase().slice(-6)}`,
        reason,
        summary,
        contactEmail: contact_email,
        // Only attach an order the shopper proved is theirs.
        orderName: orderName && ctx.verifiedOrders.has(orderName) ? orderName : null,
        createdAt: ctx.now().toISOString(),
      };
      ctx.handoff = ticket;
      await ctx.onHandoff(ticket);
      return { ticket_id: ticket.ticketId, expected_reply: "within 1 business day, by email" };
    },
  }),
} satisfies { [K in keyof typeof s]: ToolDef<K> };

export type ToolName = keyof typeof TOOLS;

function orderView(ctx: ToolContext, o: Order) {
  remember(ctx, o.subtotal, o.discount, o.shipping, o.total, ...o.lines.map((l) => l.price));
  return {
    order: o.name,
    placed_on: o.createdAt.slice(0, 10),
    payment: o.financialStatus,
    status: o.fulfillmentStatus,
    items: o.lines.map((l) => ({ title: l.title, variant: l.variantTitle, quantity: l.quantity, price: l.price })),
    total: o.total,
    currency: o.currency,
    tracking: o.tracking ? { carrier: o.tracking.carrier, number: o.tracking.number, shipped_on: o.tracking.shippedOn, estimated_delivery: o.tracking.estimatedDelivery } : null,
  };
}

export interface Step {
  n: number;
  tool: string;
  input: unknown;
  summary: string;
  output: unknown;
  error?: string;
}

/** Runs one tool call: rejects unknown tools, validates input, records the step. */
export async function runTool(ctx: ToolContext, steps: Step[], name: string, rawInput: unknown): Promise<Record<string, unknown>> {
  const n = steps.length + 1;
  const tool = (TOOLS as Record<string, ToolDef>)[name];
  if (!tool) {
    steps.push({ n, tool: name, input: rawInput, summary: "Rejected: not an allowed tool", output: null, error: "not allowed" });
    return { error: `Unknown tool ${name}.` };
  }
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    steps.push({ n, tool: name, input: rawInput, summary: `Invalid input — ${msg}`, output: null, error: msg });
    return { error: `Invalid input: ${msg}` };
  }
  try {
    const out = (await tool.run(ctx, parsed.data as never)) as Record<string, unknown>;
    steps.push({ n, tool: name, input: parsed.data, summary: summarize(name, out), output: out });
    return out;
  } catch (err) {
    const msg = (err as Error).message;
    steps.push({ n, tool: name, input: parsed.data, summary: `Error: ${msg}`, output: null, error: msg });
    return { error: "The store could not be reached. Offer to connect the shopper with the support team." };
  }
}

function summarize(name: string, out: Record<string, unknown>): string {
  if ("error" in out) return `Error: ${out.error}`;
  switch (name) {
    case "search_products":
      return `${out.count} product(s) found`;
    case "get_product":
      return `${out.title}: ${(out.variants as unknown[]).length} variants`;
    case "get_policy":
      return `${out.title}`;
    case "lookup_order":
      return out.found ? `Order ${out.order} verified — ${out.status}` : "No match for that number + email";
    case "create_handoff":
      return `Ticket ${out.ticket_id} for the support team`;
    default:
      return "Done";
  }
}
