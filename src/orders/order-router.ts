import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { OrderForwarder } from "./order-forwarder";
import { parseShopifyOrder } from "./shopify";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createOrderRouter(forwarder: OrderForwarder, webhookSecret: string, logger: Logger): Router {
  const router = Router();
  router.post("/webhooks/orders", async (req, res) => {
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const supplied = req.header("X-Shopify-Hmac-Sha256");
    if (!webhookSecret) {
      logger.error("Shopify-webhooksecret ontbreekt");
      res.status(503).json({ error: "webhook is not configured" });
      return;
    }
    if (!rawBody || !validSignature(rawBody, supplied, webhookSecret)) {
      logger.warn("ongeldige Shopify-webhookhandtekening");
      res.status(401).json({ error: "invalid webhook signature" });
      return;
    }

    let order;
    try {
      order = parseShopifyOrder(req.body);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "ongeldige bestelling" });
      return;
    }
    try {
      // Wait only for the durable processing claim, never for the retry ladder.
      const accepted = await forwarder.enqueue(order);
      res.status(202).json({
        status: accepted.duplicate ? "duplicate_ignored" : "accepted",
        orderReference: order.reference,
      });
    } catch (error) {
      logger.error("order kon niet duurzaam worden geaccepteerd", {
        orderReference: order.reference,
        reason: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({ error: "order could not be queued", orderReference: order.reference });
    }
  });
  return router;
}

function validSignature(body: Buffer, supplied: string | undefined, secret: string): boolean {
  if (!supplied) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(supplied, "base64");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
