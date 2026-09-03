import type { ShopOrder } from "./types";

interface ShopifyMoney {
  amount?: string;
  currency_code?: string;
}

interface ShopifyOrder {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  currency?: string;
  line_items?: Array<{
    sku?: string;
    quantity?: number;
    price?: string;
    total_discount?: string;
  }>;
  total_discounts?: string;
  total_shipping_price_set?: { shop_money?: ShopifyMoney };
}

function cents(value: string | undefined, field: string): number {
  const parsed = Number(value ?? "0");
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative amount`);
  }
  return Math.round(parsed * 100);
}

/** Convert the Shopify orders/create webhook into the explicit bridge domain model. */
export function parseShopifyOrder(value: unknown): ShopOrder {
  if (typeof value !== "object" || value === null) {
    throw new Error("order payload must be an object");
  }
  const order = value as ShopifyOrder;
  const reference = String(order.admin_graphql_api_id ?? order.id ?? order.name ?? "").trim();
  if (!reference) throw new Error("order reference is required");
  if (order.currency !== "EUR") throw new Error("order currency must be EUR");
  if (!Array.isArray(order.line_items) || order.line_items.length === 0) {
    throw new Error("order must contain at least one line");
  }

  const lines = order.line_items.map((line, index) => {
    const sku = line.sku?.trim();
    if (!sku) throw new Error(`line ${index + 1} must contain a SKU`);
    if (!Number.isInteger(line.quantity) || (line.quantity ?? 0) <= 0) {
      throw new Error(`line ${index + 1} must contain a positive quantity`);
    }
    return {
      sku,
      quantity: line.quantity!,
      unitPriceCents: cents(line.price, `line ${index + 1} price`),
      discountCents: cents(line.total_discount, `line ${index + 1} discount`),
    };
  });

  return {
    reference,
    currency: "EUR",
    lines,
    discountCents: cents(order.total_discounts, "total discount"),
    shippingCents: cents(
      order.total_shipping_price_set?.shop_money?.amount,
      "shipping price",
    ),
  };
}
