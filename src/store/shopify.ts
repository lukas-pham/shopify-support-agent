import type { Order, OrderLine, Policy, Product, Review, SampleStore, StoreBackend } from "./types";
import { SampleBackend, normalizeOrderNumber, scoreProduct, tokenize } from "./sample";

/** Shopify search ANDs bare terms; shoppers type sentences. Keep the keywords and OR them, ranked by relevance. */
export const toSearchSyntax = (text: string) => tokenize(text).slice(0, 6).join(" OR ");

/**
 * Real-store backend: Admin GraphQL API with a custom-app token.
 * Scopes: read_products, read_orders, read_legal_policies (+ read_inventory for stock counts).
 * Every operation below was validated against Admin API 2026-10 with the Shopify AI Toolkit.
 *
 * Reviews: Shopify has no native review API. Review apps (Judge.me, Okendo, Shopify Product Reviews)
 * write the standard `reviews.rating` / `reviews.rating_count` metafields, so the agent can quote the
 * average rating; it never sees review text in this backend.
 */

const PRODUCT_FIELDS = /* GraphQL */ `
fragment SupportProduct on Product {
  id
  handle
  title
  productType
  tags
  description
  onlineStoreUrl
  featuredMedia { preview { image { url } } }
  options { name values }
  rating: metafield(namespace: "reviews", key: "rating") { jsonValue }
  ratingCount: metafield(namespace: "reviews", key: "rating_count") { jsonValue }
  variants(first: 100) {
    nodes { id title sku price inventoryQuantity selectedOptions { name value } }
  }
}`;

export const SEARCH_PRODUCTS = /* GraphQL */ `${PRODUCT_FIELDS}
query SearchProducts($query: String!, $first: Int!) {
  products(first: $first, query: $query, sortKey: RELEVANCE) { nodes { ...SupportProduct } }
}`;

export const PRODUCT_BY_HANDLE = /* GraphQL */ `${PRODUCT_FIELDS}
query ProductByHandle($identifier: ProductIdentifierInput!) {
  product: productByIdentifier(identifier: $identifier) { ...SupportProduct }
}`;

export const ORDER_FOR_CUSTOMER = /* GraphQL */ `
query OrderForCustomer($query: String!) {
  orders(first: 1, query: $query) {
    nodes {
      id
      name
      createdAt
      email
      cancelledAt
      displayFinancialStatus
      displayFulfillmentStatus
      shippingAddress { countryCodeV2 }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount } }
      totalShippingPriceSet { shopMoney { amount } }
      totalPriceSet { shopMoney { amount } }
      discountCodes
      lineItems(first: 50) {
        nodes { title variantTitle sku quantity originalUnitPriceSet { shopMoney { amount } } variant { id } product { id } }
      }
      fulfillments(first: 5) {
        status
        displayStatus
        createdAt
        estimatedDeliveryAt
        trackingInfo(first: 1) { company number url }
      }
    }
  }
}`;

export const SHOP_POLICIES = /* GraphQL */ `
query ShopPolicies {
  shop { shopPolicies { type title body } }
}`;

type Money = { shopMoney: { amount: string; currencyCode?: string } };
interface AdminProduct {
  id: string;
  handle: string;
  title: string;
  productType: string;
  tags: string[];
  description: string;
  onlineStoreUrl: string | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  options: { name: string; values: string[] }[];
  rating: { jsonValue: { value: string } } | null;
  ratingCount: { jsonValue: number } | null;
  variants: { nodes: { id: string; title: string; sku: string | null; price: string; inventoryQuantity: number | null; selectedOptions: { name: string; value: string }[] }[] };
}

const tail = (gid: string) => gid.split("/").pop() ?? gid;

function mapProduct(p: AdminProduct): Product & { rating?: { average: number; count: number } } {
  return {
    id: tail(p.id),
    handle: p.handle,
    title: p.title,
    productType: p.productType,
    category: p.productType,
    tags: p.tags,
    description: p.description,
    image: p.featuredMedia?.preview?.image?.url ?? null,
    url: `/products/${p.handle}`,
    options: p.options,
    variants: p.variants.nodes.map((v) => ({
      id: tail(v.id),
      title: v.title,
      sku: v.sku ?? "",
      price: Number(v.price),
      options: Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])),
      inventory: v.inventoryQuantity ?? 0,
    })),
    ...(p.rating && p.ratingCount ? { rating: { average: Number(p.rating.jsonValue.value), count: p.ratingCount.jsonValue } } : {}),
  };
}

const POLICY_TYPES: Record<string, string> = { shipping: "SHIPPING_POLICY", returns: "REFUND_POLICY", terms: "TERMS_OF_SERVICE", privacy: "PRIVACY_POLICY" };

export class ShopifyAdminBackend implements StoreBackend {
  readonly name = "shopify";
  private policies: Promise<Record<string, Policy>> | null = null;

  /** `extraPolicies` covers topics Shopify has no policy type for (sizing, warranty, wholesale, discounts). */
  constructor(
    private domain: string,
    private token: string,
    private version: string,
    private extraPolicies: Record<string, Policy> = {},
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`https://${this.domain}/admin/api/${this.version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.token },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Shopify Admin API ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors) throw new Error(`Shopify Admin API error: ${JSON.stringify(json.errors).slice(0, 300)}`);
    return json.data as T;
  }

  async searchProducts(query: string, limit: number): Promise<Product[]> {
    // Only active products are ever shown to shoppers.
    const q = `status:active AND (${toSearchSyntax(query) || "*"})`;
    const data = await this.gql<{ products: { nodes: AdminProduct[] } }>(SEARCH_PRODUCTS, { query: q, first: limit });
    return data.products.nodes.map(mapProduct);
  }

  async getProduct(handle: string): Promise<Product | null> {
    const data = await this.gql<{ product: AdminProduct | null }>(PRODUCT_BY_HANDLE, { identifier: { handle } });
    return data.product ? mapProduct(data.product) : null;
  }

  async getReviews(): Promise<Review[]> {
    return []; // rating summary comes from metafields on the product (see mapProduct)
  }

  async getPolicy(topic: string): Promise<Policy | null> {
    this.policies ??= this.gql<{ shop: { shopPolicies: { type: string; title: string; body: string }[] } }>(SHOP_POLICIES).then((d) => {
      const out: Record<string, Policy> = { ...this.extraPolicies };
      for (const [key, type] of Object.entries(POLICY_TYPES)) {
        const p = d.shop.shopPolicies.find((x) => x.type === type);
        if (p?.body) out[key] = { title: p.title, body: stripHtml(p.body) };
      }
      return out;
    });
    return (await this.policies)[topic] ?? null;
  }

  async findOrderForCustomer(orderNumber: string, email: string): Promise<Order | null> {
    const name = normalizeOrderNumber(orderNumber);
    const mail = email.trim().toLowerCase();
    if (!/^#\d{3,10}$/.test(name) || !/^[^\s@"]+@[^\s@"]+$/.test(mail)) return null;
    const data = await this.gql<{ orders: { nodes: AdminOrder[] } }>(ORDER_FOR_CUSTOMER, { query: `name:${name} AND email:"${mail}"` });
    const o = data.orders.nodes[0];
    // Search syntax is fuzzy; the exact check happens here, in code.
    if (!o || o.name !== name || (o.email ?? "").toLowerCase() !== mail) return null;
    return mapOrder(o);
  }
}

interface AdminOrder {
  id: string;
  name: string;
  createdAt: string;
  email: string | null;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string;
  shippingAddress: { countryCodeV2: string | null } | null;
  subtotalPriceSet: Money;
  totalDiscountsSet: Money;
  totalShippingPriceSet: Money;
  totalPriceSet: Money;
  discountCodes: string[];
  lineItems: { nodes: { title: string; variantTitle: string | null; sku: string | null; quantity: number; originalUnitPriceSet: Money; variant: { id: string } | null; product: { id: string } | null }[] };
  fulfillments: { status: string; displayStatus: string | null; createdAt: string; estimatedDeliveryAt: string | null; trackingInfo: { company: string | null; number: string | null; url: string | null }[] }[];
}

function mapOrder(o: AdminOrder): Order {
  const f = o.fulfillments[0];
  const display = f?.displayStatus ?? "";
  const status: Order["fulfillmentStatus"] = o.cancelledAt
    ? "cancelled"
    : display === "DELIVERED"
      ? "delivered"
      : display === "IN_TRANSIT" || display === "OUT_FOR_DELIVERY"
        ? "in_transit"
        : f
          ? "shipped"
          : "unfulfilled";
  const lines: OrderLine[] = o.lineItems.nodes.map((l) => ({
    productId: l.product ? tail(l.product.id) : "",
    variantId: l.variant ? tail(l.variant.id) : "",
    sku: l.sku ?? "",
    title: l.title,
    variantTitle: l.variantTitle ?? "",
    quantity: l.quantity,
    price: Number(l.originalUnitPriceSet.shopMoney.amount),
  }));
  return {
    id: tail(o.id),
    name: o.name,
    createdAt: o.createdAt,
    customerId: "",
    email: o.email ?? "",
    shippingCountry: o.shippingAddress?.countryCodeV2 ?? "",
    lines,
    subtotal: Number(o.subtotalPriceSet.shopMoney.amount),
    discount: Number(o.totalDiscountsSet.shopMoney.amount),
    discountTitle: o.discountCodes[0] ?? null,
    shipping: Number(o.totalShippingPriceSet.shopMoney.amount),
    total: Number(o.totalPriceSet.shopMoney.amount),
    currency: o.subtotalPriceSet.shopMoney.currencyCode ?? "USD",
    financialStatus: o.displayFinancialStatus === "REFUNDED" ? "refunded" : "paid",
    fulfillmentStatus: status,
    tracking: f?.trackingInfo[0]?.number
      ? { carrier: f.trackingInfo[0].company ?? "", number: f.trackingInfo[0].number, shippedOn: f.createdAt.slice(0, 10), estimatedDelivery: f.estimatedDeliveryAt?.slice(0, 10) ?? "" }
      : null,
    note: null, // never read: order notes are customer text and a prompt-injection channel
    tags: [],
  };
}

const stripHtml = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * Products live from the public mock.shop Storefront API (no credentials); orders, reviews,
 * stock counts and policies from the sample file. Proves the Storefront path end to end without a store.
 */
const MOCKSHOP_PRODUCT = /* GraphQL */ `
fragment StorefrontProduct on Product {
  id
  handle
  title
  productType
  tags
  description
  featuredImage { url }
  options { name optionValues { name } }
  variants(first: 100) {
    nodes { id title sku availableForSale price { amount } selectedOptions { name value } }
  }
}`;
const MOCKSHOP_SEARCH = `${MOCKSHOP_PRODUCT}
query SearchProducts($query: String!, $first: Int!) {
  products(first: $first, query: $query, sortKey: RELEVANCE) { nodes { ...StorefrontProduct } }
}`;
const MOCKSHOP_BY_HANDLE = `${MOCKSHOP_PRODUCT}
query ProductByHandle($handle: String!) {
  product(handle: $handle) { ...StorefrontProduct }
}`;

interface StorefrontProduct {
  id: string;
  handle: string;
  title: string;
  productType: string;
  tags: string[];
  description: string;
  featuredImage: { url: string } | null;
  options: { name: string; optionValues: { name: string }[] }[];
  variants: { nodes: { id: string; title: string; sku: string | null; availableForSale: boolean; price: { amount: string }; selectedOptions: { name: string; value: string }[] }[] };
}

export class MockShopBackend extends SampleBackend {
  override readonly name = "mockshop";
  constructor(
    data: SampleStore,
    private endpoint = "https://apparel-outdoor.mock.shop/api",
  ) {
    super(data);
  }

  private async sf<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (!res.ok || json.errors) throw new Error(`mock.shop error ${res.status}`);
    return json.data as T;
  }

  private map(p: StorefrontProduct): Product {
    const known = this.data.products.find((x) => x.handle === p.handle);
    return {
      id: tail(p.id).split("?")[0],
      handle: p.handle,
      title: p.title,
      productType: p.productType,
      category: p.tags[1] ?? p.productType,
      tags: p.tags,
      description: p.description,
      image: p.featuredImage?.url ?? null,
      url: `/products/${p.handle}`,
      options: p.options.map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
      variants: p.variants.nodes.map((v) => {
        const id = tail(v.id).split("?")[0];
        const stock = known?.variants.find((x) => x.id === id)?.inventory;
        return { id, title: v.title, sku: v.sku ?? "", price: Number(v.price.amount), options: Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value])), inventory: v.availableForSale ? (stock ?? 10) : 0 };
      }),
    };
  }

  private catalog: { at: number; products: Promise<Product[]> } | null = null;

  /**
   * mock.shop is a mock: it ignores the `query` search argument and always returns the catalog in the same
   * order (checked 2026-11-26). So the live catalog is fetched (cached 5 min) and ranked here.
   * Against a real store, ShopifyAdminBackend uses Shopify's own search.
   */
  override async searchProducts(query: string, limit: number): Promise<Product[]> {
    if (!this.catalog || Date.now() - this.catalog.at > 5 * 60_000) {
      const products = this.sf<{ products: { nodes: StorefrontProduct[] } }>(MOCKSHOP_SEARCH, { query: "", first: 100 }).then((d) => d.products.nodes.map((p) => this.map(p)));
      this.catalog = { at: Date.now(), products };
      products.catch(() => (this.catalog = null));
    }
    const terms = tokenize(query);
    return (await this.catalog.products)
      .map((p) => ({ p, s: scoreProduct(p, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.p);
  }

  override async getProduct(handle: string): Promise<Product | null> {
    const d = await this.sf<{ product: StorefrontProduct | null }>(MOCKSHOP_BY_HANDLE, { handle });
    return d.product ? this.map(d.product) : null;
  }
}
