/** Shape of data/sample-store.json. The Shopify backend maps Admin API data onto the same types. */

export interface Variant {
  id: string;
  title: string;
  sku: string;
  price: number;
  options: Record<string, string>;
  inventory: number;
}

export interface Product {
  id: string;
  handle: string;
  title: string;
  productType: string;
  category: string;
  tags: string[];
  description: string;
  image: string | null;
  url: string;
  options: { name: string; values: string[] }[];
  variants: Variant[];
}

export interface OrderLine {
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  variantTitle: string;
  quantity: number;
  price: number;
}

export type FulfillmentStatus = "unfulfilled" | "shipped" | "in_transit" | "delivered" | "cancelled";

export interface Order {
  id: string;
  name: string;
  createdAt: string;
  customerId: string;
  email: string;
  shippingCountry: string;
  lines: OrderLine[];
  subtotal: number;
  discount: number;
  discountTitle: string | null;
  shipping: number;
  total: number;
  currency: string;
  financialStatus: "paid" | "refunded";
  fulfillmentStatus: FulfillmentStatus;
  tracking: { carrier: string; number: string; shippedOn: string; estimatedDelivery: string } | null;
  note: string | null;
  tags: string[];
}

export interface Review {
  id: string;
  productId: string;
  productTitle: string;
  rating: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  country: string;
  tags: string[];
  company?: string;
}

export interface Policy {
  title: string;
  body: string;
}

export interface SampleStore {
  shop: { name: string; currency: string; today: string; supportEmail: string; lowStockThreshold: number };
  products: Product[];
  customers: Customer[];
  orders: Order[];
  reviews: Review[];
  policies: Record<string, Policy>;
}

/** Everything the support tools need. Two implementations: sample data and a real Shopify store. */
export interface StoreBackend {
  readonly name: string;
  searchProducts(query: string, limit: number): Promise<Product[]>;
  getProduct(handle: string): Promise<Product | null>;
  getReviews(productId: string): Promise<Review[]>;
  getPolicy(topic: string): Promise<Policy | null>;
  /** Returns the order only if BOTH the order number and the email match. Never reveals which one was wrong. */
  findOrderForCustomer(orderNumber: string, email: string): Promise<Order | null>;
}
