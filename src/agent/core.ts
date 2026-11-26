import { checkReply, FALLBACK_MESSAGE, type Reply } from "./guards";
import { runTool, TOOLS, type HandoffTicket, type Step, type ToolContext } from "./tools";

/** One shopper message in, one checked reply out. Platform-agnostic (runs in Node and the browser). */

export const MAX_STEPS = 6;

export interface ProductCard {
  handle: string;
  title: string;
  url: string;
  image: string | null;
  price: string;
  inStock: boolean;
}

export interface ChatResult {
  message: string;
  products: ProductCard[];
  handoff: HandoffTicket | null;
  steps: Step[];
  mode: "live" | "demo";
  /** Guard problems found in the model's draft (the shopper never sees a failed draft). */
  blocked: string[];
}

/** A driver decides which tools to call and writes the reply: Claude in live mode, a keyword router in demo mode. */
export interface AgentDriver {
  readonly mode: "live" | "demo";
  turn(input: {
    message: string;
    history: { role: "user" | "assistant"; text: string }[];
    ctx: ToolContext;
    /** Driver-owned memory for this conversation (live mode keeps the raw Claude message list here). */
    state: Record<string, unknown>;
    call: (name: string, input: unknown) => Promise<Record<string, unknown>>;
  }): Promise<Reply>;
}

export interface Conversation {
  ctx: ToolContext;
  history: { role: "user" | "assistant"; text: string }[];
  driverState: Record<string, unknown>;
}

export async function handleMessage(conv: Conversation, driver: AgentDriver, message: string): Promise<ChatResult> {
  const steps: Step[] = [];
  const ctx = conv.ctx;
  const call = async (name: string, input: unknown) => {
    if (steps.length >= MAX_STEPS) return { error: "Step limit reached. Write your reply now." };
    return runTool(ctx, steps, name, input);
  };

  let reply: Reply;
  try {
    reply = await driver.turn({ message, history: conv.history, ctx, state: conv.driverState, call });
  } catch (err) {
    reply = { message: "", product_handles: [], offer_handoff: true };
    steps.push({ n: steps.length + 1, tool: "agent", input: null, summary: `Agent error: ${(err as Error).message}`, output: null, error: (err as Error).message });
  }

  const guard = reply.message ? checkReply(reply, ctx) : { ok: false, problems: ["no reply"], handles: [] };
  let text = reply.message;
  if (!guard.ok) {
    if (!ctx.handoff) {
      // Direct runTool: the safety handoff must not be blocked by the step limit.
      await runTool(ctx, steps, "create_handoff", {
        reason: "not_sure_of_answer",
        summary: `Automatic handoff: the assistant's draft reply failed checks (${guard.problems.join("; ")}). Shopper asked: "${message.slice(0, 300)}"`,
        contact_email: null,
        order_number: null,
      });
    }
    text = FALLBACK_MESSAGE;
  }

  const products: ProductCard[] = [];
  for (const handle of guard.ok ? guard.handles : []) {
    const p = await ctx.store.getProduct(handle);
    if (!p) continue;
    const prices = p.variants.map((v) => v.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    products.push({ handle, title: p.title, url: p.url, image: p.image, price: lo === hi ? `$${lo.toFixed(2)}` : `$${lo.toFixed(2)} – $${hi.toFixed(2)}`, inStock: p.variants.some((v) => v.inventory > 0) });
  }

  conv.history.push({ role: "user", text: message }, { role: "assistant", text });
  return { message: text, products: products.slice(0, 3), handoff: ctx.handoff, steps, mode: driver.mode, blocked: guard.ok ? [] : guard.problems };
}

export const TOOL_NAMES = Object.keys(TOOLS);
