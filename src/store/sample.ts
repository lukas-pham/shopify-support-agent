import type { Order, Policy, Product, Review, SampleStore, StoreBackend } from "./types";

/**
 * Backend over data/sample-store.json. No Node imports on purpose: the same class runs
 * in the browser playground on the portfolio site.
 */

const STOP = new Set(["a", "an", "the", "for", "and", "or", "of", "to", "in", "on", "with", "do", "you", "have", "any", "i", "need", "want", "looking", "something", "some", "me", "my", "is", "are", "it", "that", "what", "which", "good", "best"]);
const SYNONYMS: Record<string, string[]> = {
  rain: ["waterproof", "shell", "storm"],
  raincoat: ["waterproof", "shell", "jacket"],
  // tokenize() drops a trailing "s" on longer words, so keys are singular.
  waterproof: ["waterproof", "shell", "weather"],
  coat: ["jacket", "shell", "outerwear"],
  jacket: ["jacket", "shell"],
  trouser: ["pants", "trousers", "joggers"],
  pant: ["pants", "trousers", "joggers"],
  jogger: ["joggers", "pants"],
  hiking: ["hiking", "trail", "trekking", "technical"],
  hike: ["hiking", "trail", "trekking"],
  bag: ["backpack"],
  pack: ["backpack"],
  sock: ["socks"],
  tee: ["t-shirt", "tee", "top"],
  shirt: ["t-shirt", "tee", "top"],
  pole: ["pole", "trekking"],
  cap: ["cap", "hat"],
  hat: ["hat", "cap"],
  chair: ["stool"],
  glove: ["gloves"],
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/s$/, (m) => (t.length > 4 ? "" : m)))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function scoreProduct(p: Product, terms: string[]): number {
  const title = p.title.toLowerCase();
  const meta = `${p.productType} ${p.category} ${p.tags.join(" ")}`.toLowerCase();
  const body = p.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const variants = [term, ...(SYNONYMS[term] ?? [])];
    if (variants.some((v) => title.includes(v))) score += 3;
    else if (variants.some((v) => meta.includes(v))) score += 2;
    else if (variants.some((v) => body.includes(v))) score += 1;
  }
  return score;
}

export class SampleBackend implements StoreBackend {
  readonly name: string = "sample";
  constructor(readonly data: SampleStore) {}

  async searchProducts(query: string, limit: number): Promise<Product[]> {
    const terms = tokenize(query);
    if (!terms.length) return this.data.products.slice(0, limit);
    return this.data.products
      .map((p) => ({ p, s: scoreProduct(p, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.p);
  }

  async getProduct(handle: string): Promise<Product | null> {
    return this.data.products.find((p) => p.handle === handle) ?? null;
  }

  async getReviews(productId: string): Promise<Review[]> {
    return this.data.reviews.filter((r) => r.productId === productId);
  }

  async getPolicy(topic: string): Promise<Policy | null> {
    return this.data.policies[topic] ?? null;
  }

  async findOrderForCustomer(orderNumber: string, email: string): Promise<Order | null> {
    const name = normalizeOrderNumber(orderNumber);
    const mail = email.trim().toLowerCase();
    const order = this.data.orders.find((o) => o.name === name);
    // Same answer for "no such order" and "wrong email" so nobody can probe order numbers.
    if (!order || order.email.toLowerCase() !== mail) return null;
    return order;
  }
}

export function normalizeOrderNumber(input: string): string {
  const digits = input.replace(/[^0-9]/g, "");
  return `#${digits}`;
}
