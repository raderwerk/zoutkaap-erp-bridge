import { Router } from "express";
import { OrderForwardingError, type OrderForwarder } from "./order-forwarder";
import { parseShopifyOrder } from "./shopify";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export function createOrderRouter(forwarder: OrderForwarder): Router {
  const router = Router();
  router.post("/webhooks/orders", async (req, res) => {
    try {
      const order = parseShopifyOrder(req.body);
      const result = await forwarder.forward(order);
      res.status(result.duplicate ? 200 : 201).json({
        status: result.duplicate ? "duplicate_ignored" : "forwarded",
        orderReference: order.reference,
        erpOrderId: result.erpOrderId,
      });
    } catch (error) {
      if (error instanceof OrderForwardingError) {
        res.status(502).json({ error: error.message, orderReference: error.orderReference });
        return;
      }
      res.status(400).json({
        error: error instanceof Error ? error.message : "ongeldige bestelling",
      });
    }
  });
  return router;
}
