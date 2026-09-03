import express, { type Express } from "express";
import { logger } from "./logger";

const startedAt = new Date();

/**
 * Bouwt de Express-app op, los van het starten van een server.
 * Zo kan een test de app aanroepen zonder een echte poort te binden.
 *
 * De voorraadsync (Z03), orderdoorgifte met retry en idempotentie (Z04) en de
 * uitgebreide statuspagina (Z05) landen hier in latere werkvloer-issues; dit
 * skelet biedt alleen de health- en statusendpoints zodat CI groen kan draaien.
 */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

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
      sync: { lastRun: null, note: "nog niet geïmplementeerd (Z03)" },
      orders: { lastForwarded: null, note: "nog niet geïmplementeerd (Z04)" },
    });
  });

  return app;
}
