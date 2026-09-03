import { createApp } from "./app";
import { ErpClient } from "./erp-client";
import { syncInventory } from "./inventory-sync";
import { logger } from "./logger";
import { JsonlDeadLetterQueue } from "./orders/dead-letter";
import { HttpErpClient } from "./orders/erp-client";
import { JsonlIdempotencyStore } from "./orders/idempotency";
import { OrderForwarder } from "./orders/order-forwarder";
import { ShopifyClient } from "./shopify-client";

const port = Number(process.env.PORT ?? 3000);
const dryRun = process.argv.includes("--dry-run");

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`omgevingsvariabele ${name} is verplicht`);
  return value;
}

async function runSync(): Promise<void> {
  const erp = new ErpClient({
    baseUrl: process.env.ERP_BASE_URL ?? "http://localhost:8000",
    apiKey: process.env.ERP_API_KEY ?? "zoutkaap-local-demo-key",
  });
  const shop = new ShopifyClient({
    storeDomain: requiredEnvironment("SHOPIFY_STORE_DOMAIN"),
    accessToken: requiredEnvironment("SHOPIFY_ACCESS_TOKEN"),
    locationId: requiredEnvironment("SHOPIFY_LOCATION_ID"),
    apiVersion: process.env.SHOPIFY_API_VERSION,
  });
  await syncInventory({ erp, shop, dryRun });
}

if (dryRun) {
  runSync().catch((error: unknown) => {
    logger.error("droogloop mislukt", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
} else {
  const orderForwarder = new OrderForwarder(
    new HttpErpClient(process.env.ERP_BASE_URL ?? "http://localhost:8000", process.env.ERP_API_KEY ?? "zoutkaap-local-demo-key"),
    new JsonlDeadLetterQueue(process.env.DEAD_LETTER_PATH ?? "data/order-dead-letters.jsonl"),
    logger,
    undefined,
    new JsonlIdempotencyStore(process.env.IDEMPOTENCY_PATH ?? "data/order-idempotency.jsonl"),
  );
  const app = createApp(orderForwarder);

  const server = app.listen(port, () => {
    logger.info("server gestart", { port });
    void orderForwarder.recover().catch((error: unknown) => {
      logger.error("startveegronde voor orders mislukt", { error: error instanceof Error ? error.message : String(error) });
    });
  });

  let running = false;
  const scheduledSync = async (): Promise<void> => {
    if (running) {
      logger.warn("voorraadsync overgeslagen: vorige run is nog bezig");
      return;
    }
    running = true;
    try {
      await runSync();
    } catch (error) {
      logger.error("voorraadsync mislukt", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };

  void scheduledSync();
  const syncInterval = setInterval(() => void scheduledSync(), 15 * 60 * 1_000);

  let stopping = false;
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    clearInterval(syncInterval);
    server.close();
    void orderForwarder.shutdown().finally(() => {
      logger.info("server veilig gestopt");
      process.exitCode = 0;
    });
  });
}
