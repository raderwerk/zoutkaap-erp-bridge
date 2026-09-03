import { logger as defaultLogger } from "./logger";

export interface InventoryItem {
  sku: string;
  quantity: number;
}

export interface InventorySource {
  getInventory(): Promise<InventoryItem[]>;
}

export interface InventoryTarget extends InventorySource {
  setInventory(item: InventoryItem): Promise<void>;
}

export interface SyncLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface SyncResult {
  compared: number;
  differences: number;
  writes: number;
  dryRun: boolean;
}

/**
 * Synchroniseert alleen nadat beide volledige snapshots succesvol zijn geladen.
 * Daardoor kan een kapotte of onvolledige ERP-response de winkel nooit leegschrijven.
 */
export async function syncInventory(options: {
  erp: InventorySource;
  shop: InventoryTarget;
  dryRun?: boolean;
  logger?: SyncLogger;
}): Promise<SyncResult> {
  const log = options.logger ?? defaultLogger;
  const dryRun = options.dryRun ?? false;

  let erpItems: InventoryItem[];
  try {
    erpItems = await options.erp.getInventory();
  } catch (error) {
    log.error("voorraadsync afgebroken: ERP-voorraad kon niet worden geladen; shop blijft ongewijzigd", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const shopItems = await options.shop.getInventory();
  const shopBySku = new Map(shopItems.map((item) => [item.sku, item.quantity]));
  let differences = 0;
  let writes = 0;

  for (const item of erpItems) {
    const oldQuantity = shopBySku.get(item.sku);
    if (oldQuantity === undefined) {
      log.warn("artikel uit ERP ontbreekt in shop", { sku: item.sku, newQuantity: item.quantity });
      continue;
    }
    if (oldQuantity === item.quantity) continue;

    differences += 1;
    log.info("voorraadverschil", {
      sku: item.sku,
      oldQuantity,
      newQuantity: item.quantity,
      dryRun,
    });
    if (!dryRun) {
      await options.shop.setInventory(item);
      writes += 1;
    }
  }

  const result = { compared: erpItems.length, differences, writes, dryRun };
  log.info("voorraadsync voltooid", result);
  return result;
}
