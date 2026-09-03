import { describe, expect, it, vi } from "vitest";
import type { DeadLetterQueue } from "./dead-letter";
import type { ErpClient } from "./erp-client";
import { MAX_ATTEMPTS, OrderForwarder, OrderForwardingError } from "./order-forwarder";
import type { Logger } from "./order-router";
import { MemoryIdempotencyStore } from "./idempotency";
import type { DeadLetterItem, ErpOrderRequest, ShopOrder } from "./types";

const order: ShopOrder = {
  reference: "gid://shopify/Order/173",
  currency: "EUR",
  lines: [
    { sku: "ZK-JAS-001", quantity: 2, unitPriceCents: 18_900, discountCents: 1_000 },
    { sku: "ZK-MUTS-001", quantity: 1, unitPriceCents: 2_900, discountCents: 0 },
  ],
  discountCents: 1_000,
  shippingCents: 695,
};

function setup(createOrder: ErpClient["createOrder"]) {
  const deadLetters: DeadLetterItem[] = [];
  const queue: DeadLetterQueue = { add: vi.fn(async (item) => void deadLetters.push(item)) };
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const waits: number[] = [];
  const forwarder = new OrderForwarder(
    { createOrder },
    queue,
    logger,
    async (milliseconds) => void waits.push(milliseconds),
  );
  return { forwarder, deadLetters, logger, waits };
}

describe("OrderForwarder", () => {
  it("stuurt alle orderregels volgens het ERP-mockcontract door", async () => {
    const requests: ErpOrderRequest[] = [];
    const { forwarder } = setup(async (request, key) => {
      requests.push(request);
      expect(key).toBe(order.reference);
      return { id: 42 };
    });

    await expect(forwarder.forward(order)).resolves.toEqual({ duplicate: false, erpOrderId: 42 });
    expect(requests).toEqual([{
      lines: [
        { sku: "ZK-JAS-001", quantity: 2 },
        { sku: "ZK-MUTS-001", quantity: 1 },
      ],
    }]);
  });

  it("maakt bij dubbele gelijktijdige en latere levering precies één ERP-order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createOrder = vi.fn(async () => {
      await gate;
      return { id: 51 };
    });
    const { forwarder } = setup(createOrder);

    const first = forwarder.forward(order);
    const simultaneousDuplicate = forwarder.forward(order);
    release();
    await expect(Promise.all([first, simultaneousDuplicate])).resolves.toEqual([
      { duplicate: false, erpOrderId: 51 },
      { duplicate: true, erpOrderId: undefined },
    ]);
    await expect(forwarder.forward(order)).resolves.toEqual({ duplicate: true, erpOrderId: 51 });
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("probeert een ERP 500 vier keer met oplopende wachttijd", async () => {
    const createOrder = vi.fn()
      .mockRejectedValueOnce(new Error("ERP returned HTTP 500"))
      .mockRejectedValueOnce(new Error("ERP returned HTTP 500"))
      .mockRejectedValueOnce(new Error("ERP returned HTTP 500"))
      .mockResolvedValueOnce({ id: 73 });
    const { forwarder, waits, deadLetters } = setup(createOrder);

    await expect(forwarder.forward(order)).resolves.toEqual({ duplicate: false, erpOrderId: 73 });
    expect(createOrder).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(waits).toEqual([1_000, 5_000, 25_000, 125_000]);
    expect(deadLetters).toEqual([]);
  });

  it("bewaart en logt een leesbaar dode-brievenbus-item na vier mislukkingen", async () => {
    const createOrder = vi.fn().mockRejectedValue(new Error("ERP returned HTTP 500"));
    const { forwarder, waits, deadLetters, logger } = setup(createOrder);

    await expect(forwarder.forward(order)).rejects.toEqual(new OrderForwardingError(order.reference));
    expect(createOrder).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(waits).toEqual([1_000, 5_000, 25_000, 125_000]);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      orderReference: order.reference,
      attempts: 4,
      reason: "ERP returned HTTP 500",
      order,
    });
    expect(logger.error).toHaveBeenCalledWith("order definitief mislukt", expect.objectContaining({
      orderReference: order.reference, attempts: 4, deadLetterStored: true,
    }));
  });

  it("behoudt de oorspronkelijke fout en incidentlog als de dode brievenbus faalt", async () => {
    const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const forwarder = new OrderForwarder(
      { createOrder: vi.fn().mockRejectedValue(new Error("ERP returned HTTP 500")) },
      { add: vi.fn().mockRejectedValue(new Error("permission denied /secret/path")) },
      logger,
      async () => undefined,
    );
    await expect(forwarder.forward(order)).rejects.toEqual(new OrderForwardingError(order.reference));
    expect(logger.error).toHaveBeenCalledWith("order definitief mislukt", expect.objectContaining({ deadLetterStored: false }));
  });

  it("laat een actieve retryladder bij shutdown herstelbaar achter", async () => {
    const deadLetters: DeadLetterItem[] = [];
    const abandon = vi.fn(async () => undefined);
    const forwarder = new OrderForwarder(
      { createOrder: vi.fn() },
      { add: async (item) => void deadLetters.push(item) },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      () => new Promise(() => undefined),
      {
        claim: async () => ({
          state: "claimed",
          lease: { complete: vi.fn(), fail: vi.fn(), abandon },
        }),
      },
    );

    await expect(forwarder.enqueue(order)).resolves.toEqual({ duplicate: false });
    await forwarder.shutdown();

    expect(deadLetters).toHaveLength(0);
    expect(abandon).toHaveBeenCalledOnce();
  });

  it("hervat tijdens de startveegronde achtergebleven processing-orders", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: 91 });
    const store = new MemoryIdempotencyStore() as MemoryIdempotencyStore & { recoverableOrders(): Promise<ShopOrder[]> };
    store.recoverableOrders = async () => [order];
    const forwarder = new OrderForwarder(
      { createOrder },
      { add: vi.fn() },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      async () => undefined,
      store,
    );

    await expect(forwarder.recover()).resolves.toBe(1);
    await vi.waitFor(() => expect(createOrder).toHaveBeenCalledOnce());
    await expect(forwarder.forward(order)).resolves.toEqual({ duplicate: true, erpOrderId: 91 });
  });
});
