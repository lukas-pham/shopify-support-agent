import type { AgentDriver } from "./core";
import { extractOrderRef, type Reply } from "./guards";

/**
 * Demo-mode driver: a keyword router that calls the SAME tools, guards and handoff code as live mode.
 * It exists so the app, the eval runner and the browser playground work without an API key.
 * It is deliberately simple — it shows the plumbing, not the model's judgement.
 */

type Out = Record<string, any>;
const has = (text: string, re: RegExp) => re.test(text);
const fmt = (n: number) => `$${n.toFixed(2)}`;
const priceText = (p: number | { from: number; to: number }) => (typeof p === "number" ? fmt(p) : `${fmt(p.from)}–${fmt(p.to)}`);

const STATUS_TEXT: Record<string, string> = {
  unfulfilled: "has been received and is being packed — it hasn't shipped yet",
  shipped: "has shipped",
  in_transit: "is on its way",
  delivered: "was delivered",
  cancelled: "was cancelled and refunded",
};

export const demoDriver: AgentDriver = {
  mode: "demo",
  async turn({ message, history, call }) {
    // Emails are removed before intent matching ("someone@example.com" is not a request for "someone").
    const text = message.toLowerCase().replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " ");
    const reply = (message: string, product_handles: string[] = [], offer_handoff = false): Reply => ({ message, product_handles, offer_handoff });
    const allUserText = [...history.filter((h) => h.role === "user").map((h) => h.text), message].join("\n");
    const ref = extractOrderRef(allUserText);

    // 1. Shopper wants a person.
    if (has(text, /\b(human|real person|someone|representative|talk to (an? )?(agent|person)|speak to)\b/)) {
      const t = await call("create_handoff", { reason: "customer_asked_for_human", summary: `Shopper asked for a person. Last message: "${message.slice(0, 200)}"`, contact_email: ref.email, order_number: null });
      return reply(`Of course. I've passed this to our support team (ticket ${t.ticket_id}); they reply by email within one business day.${ref.email ? "" : " What's the best email to reach you?"}`);
    }

    // 2. Orders: status, tracking, changes.
    // A follow-up counts as an order message only if it carries the details the agent just asked for.
    const own = extractOrderRef(message);
    const askedForDetails = /order number/i.test(history[history.length - 1]?.text ?? "");
    const aboutOrder = has(text, /\b(order|track|tracking|package|parcel|where is|arrive|shipped|deliver(y|ed)?)\b/) || (askedForDetails && !!(own.orderNumber || own.email));
    const wantsChange = has(text, /\b(cancel|refund|address|modify)\b/);
    if (aboutOrder && !has(text, /\b(how long|policy|cost|free shipping|ship to)\b/)) {
      if (!ref.orderNumber || !ref.email) {
        return reply("I can check that for you. Please send your order number (it starts with #) and the email address you used at checkout.");
      }
      const o: Out = await call("lookup_order", { order_number: ref.orderNumber, email: ref.email });
      if (o.error) {
        const t = await call("create_handoff", { reason: "order_problem", summary: "Several unsuccessful order lookups; shopper needs help finding their order.", contact_email: ref.email, order_number: null });
        return reply(`I couldn't match that order, so I've asked our team to help (ticket ${t.ticket_id}). They'll email you within one business day.`);
      }
      if (!o.found) return reply("I couldn't find an order with that number and email together. Could you double-check both? The order number is in your confirmation email.");
      let msg = `Order ${o.order} ${STATUS_TEXT[o.status] ?? o.status}.`;
      if (o.tracking && o.status !== "delivered") msg += ` ${o.tracking.carrier} tracking number: ${o.tracking.number}, estimated delivery ${o.tracking.estimated_delivery}.`;
      if (o.tracking && o.status === "delivered") msg += ` It shipped on ${o.tracking.shipped_on} with ${o.tracking.carrier}.`;
      if (wantsChange) {
        const reason = has(text, /address/) ? "address_change" : "refund_or_cancellation";
        const t = await call("create_handoff", { reason, summary: `Shopper asks to ${has(text, /address/) ? "change the delivery address" : "cancel or refund"} order ${o.order} (status: ${o.status}).`, contact_email: ref.email, order_number: o.order });
        msg += ` I can't change orders myself, so I've sent your request to the team (ticket ${t.ticket_id}) — they reply within one business day.`;
      }
      return reply(msg);
    }

    // 3. Damaged / defective.
    if (has(text, /\b(broken|broke|damaged|defect\w*|faulty|stuck|ripped|torn|falling apart)\b/)) {
      const w: Out = await call("get_policy", { topic: "warranty" });
      const t = await call("create_handoff", { reason: "damaged_or_defective", summary: `Shopper reports a damaged or defective item: "${message.slice(0, 200)}"`, contact_email: ref.email, order_number: ref.orderNumber });
      return reply(`Sorry about that. ${firstSentences(w.text, 1)} I've opened a ticket (${t.ticket_id}) — please reply to the team's email with a photo and your order number.`);
    }

    // 4. Policy questions.
    const policy = (
      [
        [/\b(return|refund|exchange|send (it )?back)\b/, "returns"],
        [/\b(warranty|guarantee)\b/, "warranty"],
        [/\b(wholesale|bulk|club|team order|reseller)\b/, "wholesale"],
        [/\b(discount|coupon|code|promo|price match|sale)\b/, "discounts"],
        [/\b(shipping|ship to|delivery time|how long|express|international)\b/, "shipping"],
      ] as const
    ).find(([re]) => has(text, re));
    const sizeQuestion = has(text, /\b(size|sizing|fit|runs? (small|large|big)|true to size)\b/);

    if (policy && !sizeQuestion) {
      const p: Out = await call("get_policy", { topic: policy[1] });
      if (p.error) return reply("I don't have that policy in front of me — let me connect you with the team.", [], true);
      return reply(relevantSentences(p.text, message, policy[1] === "discounts" ? 2 : 3));
    }

    // 5. Products (optionally with a size / fit question).
    const maxPrice = Number(text.match(/(?:under|below|less than|max)\s*\$?\s*(\d+)/)?.[1]) || null;
    const query = message.replace(/(?:under|below|less than|max)\s*\$?\s*\d+/i, "").slice(0, 120);
    const found: Out = await call("search_products", { query, max_price: maxPrice });
    if (found.error || !found.count) {
      if (sizeQuestion) {
        const p: Out = await call("get_policy", { topic: "sizing" });
        return reply(firstSentences(p.text, 3));
      }
      return reply("I couldn't find a product matching that. Could you describe it another way — for example the type of item and what you'll use it for?");
    }
    const top = found.results[0];
    const detail: Out = await call("get_product", { handle: top.handle });

    if (sizeQuestion) {
      const sizing: Out = await call("get_policy", { topic: "sizing" });
      const size = message.match(/\b(XXS|XS|S|M|L|XL|XXL)\b/)?.[1];
      let msg = `For the ${detail.title}: ${firstSentences(sizing.text, 1)}`;
      const fitReview = (detail.reviews_untrusted as { text: string }[]).find((r) => /small|large|snug|size/i.test(r.text));
      if (fitReview) msg += ` One customer wrote: "${fitReview.text}"`;
      if (size) {
        const v = (detail.variants as { variant: string; stock: string; price: number }[]).filter((x) => x.variant.split(" / ").includes(size));
        const inStock = v.filter((x) => x.stock !== "sold_out").map((x) => x.variant);
        msg += inStock.length ? ` Size ${size} is in stock in: ${inStock.join(", ")}.` : ` Size ${size} is sold out right now.`;
      }
      return reply(msg, [detail.handle]);
    }

    const list = (found.results as Out[]).slice(0, 3);
    const lines = list.map((r) => `${r.title} (${priceText(r.price)}${r.in_stock ? "" : ", sold out"})`);
    let msg = list.length === 1 ? `I found the ${lines[0]}.` : `Here are ${list.length} options: ${lines.join("; ")}.`;
    if (detail.rating) msg += ` The ${detail.title} is rated ${detail.rating.average}/5 by ${detail.rating.count} customer${detail.rating.count === 1 ? "" : "s"}.`;
    return reply(msg, list.map((r) => r.handle));
  },
};

/** Picks the policy sentences that share the most words with the question, kept in their original order. */
function relevantSentences(text: string, question: string, n: number): string {
  const parts = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  const stem = (w: string) => w.slice(0, 5); // crude, but "return" now matches "returned"
  const words = new Set((question.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !["what", "your", "the", "how", "does", "you", "can"].includes(w)));
  const COUNTRIES: Record<string, string> = { germany: "eu", france: "eu", spain: "eu", italy: "eu", britain: "uk", england: "uk", canada: "canada", vietnam: "vietnam", usa: "us" };
  for (const w of [...words]) if (COUNTRIES[w]) words.add(COUNTRIES[w]);
  const stems = new Set([...words].map(stem));
  const scored = parts.map((sentence, i) => ({ i, sentence, score: (sentence.toLowerCase().match(/[a-z]{2,}/g) ?? []).filter((w) => stems.has(stem(w))).length }));
  const best = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, n);
  const chosen = best.length ? best.sort((a, b) => a.i - b.i) : scored.slice(0, n);
  return chosen.map((x) => x.sentence.trim()).join(" ");
}

function firstSentences(text: string, n: number): string {
  const parts = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  return parts.slice(0, n).join(" ").trim();
}
