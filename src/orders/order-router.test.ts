import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import type { DeadLetterQueue } from "./dead-letter";
import type { ErpClient } from "./erp-client";
import { OrderForwarder } from "./order-forwarder";
import type { Logger } from "./order-router";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function start(erp: ErpClient): Promise<string> {
  const queue: DeadLetterQueue = { add: vi.fn() };
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = createApp(new OrderForwarder(erp, queue, logger, async () => undefined));
  server = await new Promise<Server>((resolve) => {
    const candidate = app.listen(0, () => resolve(candidate));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("testserver has no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("POST /webhooks/orders", () => {
  it("accepteert een Shopify order en herkent de dubbele levering", async () => {
    const createOrder = vi.fn().mockResolvedValue({ id: 17 });
    const url = await start({ createOrder });
    const payload = {
      id: 987,
      currency: "EUR",
      line_items: [{ sku: "ZK-TAS-001", quantity: 1, price: "39.00", total_discount: "4.00" }],
      total_discounts: "4.00",
      total_shipping_price_set: { shop_money: { amount: "6.95", currency_code: "EUR" } },
    };
    const send = () => fetch(`${url}/webhooks/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const first = await send();
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ status: "forwarded", erpOrderId: 17 });
    const duplicate = await send();
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ status: "duplicate_ignored", erpOrderId: 17 });
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("wijst een bestelling zonder SKU leesbaar af", async () => {
    const url = await start({ createOrder: vi.fn() });
    const response = await fetch(`${url}/webhooks/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, currency: "EUR", line_items: [{ quantity: 1 }] }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "line 1 must contain a SKU" });
  });
});
