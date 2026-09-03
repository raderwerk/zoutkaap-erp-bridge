import type { Logger } from "./order-router";
import type { DeadLetterQueue } from "./dead-letter";
import type { ErpClient } from "./erp-client";
import { MemoryIdempotencyStore, type IdempotencyStore } from "./idempotency";
import type { ErpOrderRequest, ForwardResult, ShopOrder } from "./types";

export const RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 125_000] as const;
export const MAX_ATTEMPTS = 4;

export type Delay = (milliseconds: number) => Promise<void>;

const delay: Delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export class OrderForwardingError extends Error {
  constructor(readonly orderReference: string) {
    super(`Order ${orderReference} kon na ${MAX_ATTEMPTS} pogingen niet naar het ERP worden doorgestuurd`);
  }
}

/** Coordinates retries and process-level idempotency for Shopify deliveries. */
export class OrderForwarder {
  private readonly inFlight = new Map<string, Promise<ForwardResult>>();

  constructor(
    private readonly erp: ErpClient,
    private readonly deadLetters: DeadLetterQueue,
    private readonly logger: Logger,
    private readonly wait: Delay = delay,
    private readonly idempotency: IdempotencyStore = new MemoryIdempotencyStore(),
  ) {}

  async forward(order: ShopOrder): Promise<ForwardResult> {
    const erpOrderId = await this.idempotency.get(order.reference);
    if (erpOrderId !== undefined) return { duplicate: true, erpOrderId };

    const existing = this.inFlight.get(order.reference);
    if (existing) {
      const result = await existing;
      return { ...result, duplicate: true };
    }

    const operation = this.attempt(order);
    this.inFlight.set(order.reference, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(order.reference);
    }
  }

  private async attempt(order: ShopOrder): Promise<ForwardResult> {
    const payload: ErpOrderRequest = {
      external_reference: order.reference,
      lines: order.lines.map(({ sku, quantity }) => ({ sku, quantity })),
      discount_cents: order.discountCents,
      shipping_cents: order.shippingCents,
      currency: order.currency,
    };
    let reason = "unknown ERP error";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.wait(RETRY_DELAYS_MS[attempt - 1]);
      try {
        const created = await this.erp.createOrder(payload, order.reference);
        await this.idempotency.save(order.reference, created.id);
        this.logger.info("order doorgestuurd naar ERP", {
          orderReference: order.reference,
          erpOrderId: created.id,
          attempt,
        });
        return { duplicate: false, erpOrderId: created.id };
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        this.logger.warn("ERP-orderpoging mislukt", {
          orderReference: order.reference,
          attempt,
          reason,
        });
      }
    }

    const failure = new OrderForwardingError(order.reference);
    await this.deadLetters.add({
      failedAt: new Date().toISOString(),
      orderReference: order.reference,
      attempts: MAX_ATTEMPTS,
      reason,
      order,
    });
    this.logger.error("order definitief mislukt; dode-brievenbus-item aangemaakt", {
      orderReference: order.reference,
      attempts: MAX_ATTEMPTS,
      reason,
    });
    throw failure;
  }
}
