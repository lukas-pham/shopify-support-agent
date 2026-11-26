import type { ToolContext } from "./tools";

/**
 * Checks on the agent's final reply, done in code after the model is finished.
 * A reply that fails is not sent; the shopper gets a safe fallback and the team gets a ticket.
 */

export interface Reply {
  message: string;
  product_handles: string[];
  offer_handoff: boolean;
}

export interface GuardResult {
  ok: boolean;
  problems: string[];
  /** Product handles that really came from tool results (unknown ones are dropped, never shown). */
  handles: string[];
}

const PRICE = /(?:\$|USD\s?)(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/gi;
const ORDER_REF = /#\s?(\d{3,10})\b/g;
// Things that look like a discount code: "code SAVE20", "use WELCOME10".
const CODE_OFFER = /\b(?:code|coupon|promo)\s*:?\s*["']?([A-Z0-9]{4,})\b/g;

export function checkReply(reply: Reply, ctx: ToolContext): GuardResult {
  const problems: string[] = [];

  for (const m of reply.message.matchAll(PRICE)) {
    const value = Math.round(Number(m[1].replace(/,/g, "")) * 100) / 100;
    if (!ctx.seenAmounts.has(value)) problems.push(`price ${m[0]} is not in any tool result`);
  }

  for (const m of reply.message.matchAll(ORDER_REF)) {
    if (!ctx.verifiedOrders.has(`#${m[1]}`)) problems.push(`mentions order #${m[1]} without verifying it`);
  }

  for (const m of reply.message.matchAll(CODE_OFFER)) {
    problems.push(`offers a discount code (${m[1]}) — codes are never given in chat`);
  }

  // First-person action claims ("I've refunded…", "we have updated your address"). Policy wording such as
  // "refunds are processed within 5 days" is fine.
  if (/\b(?:I|we)(?:'ve| have)?\s+(?:just\s+)?(?:refunded|cancell?ed|changed|updated|issued|applied)\b/i.test(reply.message)) {
    problems.push("claims an account change was made — the agent cannot make changes");
  }

  const handles = reply.product_handles.filter((h) => ctx.seenHandles.has(h));
  if (handles.length !== reply.product_handles.length) problems.push("referenced a product it never looked up");

  return { ok: problems.length === 0, problems, handles };
}

export const FALLBACK_MESSAGE =
  "I want to be sure I give you the right answer, so I've passed this to our support team. They'll reply by email within one business day.";

/** Removes emails, phone numbers and card-like numbers before anything is logged. */
export function redactPII(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[card]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
}

/** Pulls an email and an order number out of shopper text, for the scripted router and for logging. */
export function extractOrderRef(text: string): { orderNumber: string | null; email: string | null } {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]?.replace(/[.,;]+$/, "") ?? null;
  const orderNumber = text.match(/(?:#|order\s*(?:number|no\.?)?\s*:?\s*#?)(\d{3,10})/i)?.[1] ?? null;
  return { orderNumber, email };
}
