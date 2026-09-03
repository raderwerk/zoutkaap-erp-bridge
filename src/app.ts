import express, { type Express } from "express";
import { logger } from "./logger";
import { JsonlDeadLetterQueue } from "./orders/dead-letter";
import { HttpErpClient } from "./orders/erp-client";
import { JsonlIdempotencyStore } from "./orders/idempotency";
import { OrderForwarder } from "./orders/order-forwarder";
import { createOrderRouter } from "./orders/order-router";

const startedAt = new Date();

/**
 * Bouwt de Express-app op, los van het starten van een server.
 * Zo kan een test de app aanroepen zonder een echte poort te binden.
 *
 * De app combineert de voorraadsync-status met de orderwebhook. Een uitgebreidere
 * operationele statuspagina kan in een volgend werkvloer-issue worden toegevoegd.
 */
export function createApp(forwarder?: OrderForwarder, webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET ?? ""): Express {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));

  app.use((req, _res, next) => {
    logger.info("inkomend verzoek", { method: req.method, path: req.path });
    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/status", (_req, res) => {
    res.status(200).json({
      service: "zoutkaap-erp-bridge",
      status: "ok",
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      sync: { enabled: true, intervalMinutes: 15 },
      orders: { enabled: true, webhook: "/webhooks/orders", retryAttempts: 4 },
    });
  });

  const orderForwarder = forwarder ?? new OrderForwarder(
    new HttpErpClient(process.env.ERP_BASE_URL ?? "http://localhost:8000", process.env.ERP_API_KEY ?? "zoutkaap-local-demo-key"),
    new JsonlDeadLetterQueue(process.env.DEAD_LETTER_PATH ?? "data/order-dead-letters.jsonl"),
    logger,
    undefined,
    new JsonlIdempotencyStore(process.env.IDEMPOTENCY_PATH ?? "data/order-idempotency.jsonl"),
  );
  app.use(createOrderRouter(orderForwarder, webhookSecret, logger));

  return app;
}
