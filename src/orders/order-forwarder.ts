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
  private readonly active = new Map<string, { cancel: () => void; task: Promise<ForwardResult> }>();
  constructor(
    private readonly erp: ErpClient,
    private readonly deadLetters: DeadLetterQueue,
    private readonly logger: Logger,
    private readonly wait: Delay = delay,
    private readonly idempotency: IdempotencyStore = new MemoryIdempotencyStore(),
  ) {}

  async forward(order: ShopOrder): Promise<ForwardResult> {
    const claim = await this.idempotency.claim(order.reference, order);
    if (!claim.lease) {
      return { duplicate: true, erpOrderId: claim.erpOrderId };
    }
    return this.start(order, claim.lease);
  }

  /** Persist the processing claim, then run the slow retry ladder out of band. */
  async enqueue(order: ShopOrder): Promise<{ duplicate: boolean }> {
    const claim = await this.idempotency.claim(order.reference, order);
    if (!claim.lease) return { duplicate: true };
    void this.start(order, claim.lease).catch(() => undefined);
    return { duplicate: false };
  }

  /** Reclaims processing records left by a process that no longer owns its lock. */
  async recover(): Promise<number> {
    const orders = await this.idempotency.recoverableOrders?.() ?? [];
    let recovered = 0;
    for (const order of orders) {
      const result = await this.enqueue(order);
      if (!result.duplicate) recovered += 1;
    }
    if (recovered > 0) this.logger.info("vastgelopen orders hervat", { recovered });
    return recovered;
  }

  /** Stops retry waits and durably fails every ladder owned by this process. */
  async shutdown(): Promise<void> {
    const active = [...this.active.values()];
    for (const item of active) item.cancel();
    await Promise.allSettled(active.map((item) => item.task));
  }

  private start(order: ShopOrder, lease: IdempotencyLease): Promise<ForwardResult> {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
    const task = this.process(order, lease, cancelled)
      .finally(() => this.active.delete(order.reference));
    this.active.set(order.reference, { cancel, task });
    return task;
  }

  private async process(order: ShopOrder, lease: IdempotencyLease, cancelled?: Promise<void>): Promise<ForwardResult> {
    const payload: ErpOrderRequest = {
      lines: order.lines.map(({ sku, quantity }) => ({ sku, quantity })),
    };
    let reason = "unknown ERP error";

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const stopped = cancelled ? await Promise.race([
        this.wait(RETRY_DELAYS_MS[attempt - 1]).then(() => false),
        cancelled.then(() => true),
      ]) : false;
      if (stopped) {
        reason = "bridge stopped during order processing";
        break;
      }
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
