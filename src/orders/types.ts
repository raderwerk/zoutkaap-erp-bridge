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
  lines: Array<{ sku: string; quantity: number }>;
}

export interface ForwardResult {
  duplicate: boolean;
  erpOrderId?: number;
}

export interface DeadLetterItem {
  failedAt: string;
  orderReference: string;
  attempts: number;
  reason: string;
  order: ShopOrder;
}
