export interface ShopOrderLine {
  sku: string;
  quantity: number;
  unitPriceCents: number;
  discountCents: number;
}

export interface ShopOrder {
  reference: string;
  currency: "EUR";
  lines: ShopOrderLine[];
  discountCents: number;
  shippingCents: number;
}

export interface ErpOrderRequest {
  external_reference: string;
  lines: Array<{ sku: string; quantity: number }>;
  discount_cents: number;
  shipping_cents: number;
  currency: "EUR";
}

export interface ForwardResult {
  duplicate: boolean;
  erpOrderId: number;
}

export interface DeadLetterItem {
  failedAt: string;
  orderReference: string;
  attempts: number;
  reason: string;
  order: ShopOrder;
}
