import type { Logger } from "./order-router";
import type { DeadLetterQueue } from "./dead-letter";
import type { ErpClient } from "./erp-client";
import { MemoryIdempotencyStore, type IdempotencyLease, type IdempotencyStore } from "./idempotency";
import type { ErpOrderRequest, ForwardResult, ShopOrder } from "./types";

export const RETRY_DELAYS_MS = [1_000, 5_000, 25_000, 125_000] as const;
export const MAX_ATTEMPTS = 4;
export type Delay = (milliseconds: number) => Promise<void>;
const delay: Delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class OrderForwardingError extends Error {
  constructor(readonly orderReference: string) {
    super(`Order ${orderReference} kon na ${MAX_ATTEMPTS} pogingen niet naar het ERP worden doorgestuurd`);
  }
}

/** Claims an order durably before starting the retry ladder. */
export class OrderForwarder {
  constructor(
    private readonly erp: ErpClient,
    private readonly deadLetters: DeadLetterQueue,
    private readonly logger: Logger,
    private readonly wait: Delay = delay,
    private readonly idempotency: IdempotencyStore = new MemoryIdempotencyStore(),
  ) {}

  async forward(order: ShopOrder): Promise<ForwardResult> {
    const claim = await this.idempotency.claim(order.reference);
    if (!claim.lease) {
      return { duplicate: true, erpOrderId: claim.erpOrderId };
    }
    return this.process(order, claim.lease);
  }

  /** Persist the processing claim, then run the slow retry ladder out of band. */
  async enqueue(order: ShopOrder): Promise<{ duplicate: boolean }> {
    const claim = await this.idempotency.claim(order.reference);
    if (!claim.lease) return { duplicate: true };
    void this.process(order, claim.lease).catch(() => undefined);
    return { duplicate: false };
  }

  private async process(order: ShopOrder, lease: IdempotencyLease): Promise<ForwardResult> {
    const payload: ErpOrderRequest = {
      lines: order.lines.map(({ sku, quantity }) => ({ sku, quantity })),
    };
    let reason = "unknown ERP error";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.wait(RETRY_DELAYS_MS[attempt - 1]);
      try {
        const created = await this.erp.createOrder(payload, order.reference);
        await lease.complete(created.id);
        this.logger.info("order doorgestuurd naar ERP", { orderReference: order.reference, erpOrderId: created.id, attempt });
        return { duplicate: false, erpOrderId: created.id };
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        this.logger.warn("ERP-orderpoging mislukt", { orderReference: order.reference, attempt, reason });
      }
    }

    const failure = new OrderForwardingError(order.reference);
    let deadLetterStored = false;
    try {
      await this.deadLetters.add({ failedAt: new Date().toISOString(), orderReference: order.reference, attempts: MAX_ATTEMPTS, reason, order });
      deadLetterStored = true;
    } catch (deadLetterError) {
      this.logger.error("dode brievenbus kon niet worden geschreven", {
        orderReference: order.reference,
        reason: deadLetterError instanceof Error ? deadLetterError.message : String(deadLetterError),
      });
    }
    await lease.fail(reason).catch((stateError) => {
      this.logger.error("definitieve orderstatus kon niet worden vastgelegd", {
        orderReference: order.reference,
        reason: stateError instanceof Error ? stateError.message : String(stateError),
      });
    });
    this.logger.error("order definitief mislukt", {
      orderReference: order.reference, attempts: MAX_ATTEMPTS, reason, deadLetterStored,
    });
    throw failure;
  }
}
