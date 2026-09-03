import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import type { DeadLetterQueue } from "./dead-letter";
import type { ErpClient } from "./erp-client";
import { OrderForwarder } from "./order-forwarder";
import type { Logger } from "./order-router";

const secret = "test-only-shopify-secret";
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function start(erp: ErpClient): Promise<string> {
  const queue: DeadLetterQueue = { add: vi.fn() };
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const app = createApp(new OrderForwarder(erp, queue, logger, async () => undefined), secret);
  server = await new Promise<Server>((resolve) => {
    const candidate = app.listen(0, () => resolve(candidate));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("testserver has no port");
  return `http://127.0.0.1:${address.port}`;
}

const payload = {
  id: 987,
  currency: "EUR",
  line_items: [{ sku: "ZK-TAS-001", quantity: 1, price: "39.00", total_discount: "4.00" }],
  total_discounts: "4.00",
  total_shipping_price_set: { shop_money: { amount: "6.95", currency_code: "EUR" } },
};

function signed(body: string, signature = createHmac("sha256", secret).update(body).digest("base64")) {
  return { method: "POST", headers: { "content-type": "application/json", "x-shopify-hmac-sha256": signature }, body };
}

describe("POST /webhooks/orders", () => {
  it("answers 202 immediately and processes duplicate deliveries only once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createOrder = vi.fn(async () => { await gate; return { id: 17 }; });
    const url = await start({ createOrder });
    const body = JSON.stringify(payload);
    expect((await fetch(`${url}/webhooks/orders`, signed(body))).status).toBe(202);
    expect((await fetch(`${url}/webhooks/orders`, signed(body))).status).toBe(202);
    release();
    await vi.waitFor(() => expect(createOrder).toHaveBeenCalledTimes(1));
  });

  it("rejects a forged or missing Shopify signature before forwarding", async () => {
    const createOrder = vi.fn();
    const url = await start({ createOrder });
    const body = JSON.stringify(payload);
    expect((await fetch(`${url}/webhooks/orders`, signed(body, "forged"))).status).toBe(401);
    expect((await fetch(`${url}/webhooks/orders`, { method: "POST", headers: { "content-type": "application/json" }, body })).status).toBe(401);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("rejects an invalid signed order readably", async () => {
    const url = await start({ createOrder: vi.fn() });
    const body = JSON.stringify({ id: 1, currency: "EUR", line_items: [{ quantity: 1 }] });
    const response = await fetch(`${url}/webhooks/orders`, signed(body));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "line 1 must contain a SKU" });
  });
});
