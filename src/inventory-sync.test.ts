import { describe, expect, it, vi } from "vitest";
import { ErpClient } from "./erp-client";
import { syncInventory, type InventoryItem, type InventoryTarget, type SyncLogger } from "./inventory-sync";

class MemoryShop implements InventoryTarget {
  readonly quantities = new Map<string, number>();
  readonly writes: InventoryItem[] = [];

  constructor(items: InventoryItem[]) {
    for (const item of items) this.quantities.set(item.sku, item.quantity);
  }

  async getInventory(): Promise<InventoryItem[]> {
    return [...this.quantities].map(([sku, quantity]) => ({ sku, quantity }));
  }

  async setInventory(item: InventoryItem): Promise<void> {
    this.writes.push(item);
    this.quantities.set(item.sku, item.quantity);
  }
}

function silentLogger(): SyncLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("syncInventory", () => {
  it("synchroniseert 200 mutaties exact en schrijft bij dezelfde stand de tweede keer niets", async () => {
    const erpItems = Array.from({ length: 200 }, (_, index) => ({ sku: `SKU-${index}`, quantity: index + 10 }));
    const shop = new MemoryShop(erpItems.map((item) => ({ ...item, quantity: item.quantity - 1 })));
    const erp = { getInventory: async () => erpItems };

    const first = await syncInventory({ erp, shop, logger: silentLogger() });
    expect(first).toEqual({ compared: 200, differences: 200, writes: 200, dryRun: false });
    expect([...shop.quantities]).toEqual(erpItems.map((item) => [item.sku, item.quantity]));

    shop.writes.length = 0;
    const second = await syncInventory({ erp, shop, logger: silentLogger() });
    expect(second).toEqual({ compared: 200, differences: 0, writes: 0, dryRun: false });
    expect(shop.writes).toHaveLength(0);
  });

  it("logt oud en nieuw per verschil en schrijft niets in droogloopstand", async () => {
    const shop = new MemoryShop([{ sku: "ZK-JAS-001", quantity: 3 }]);
    const log = silentLogger();
    const result = await syncInventory({
      erp: { getInventory: async () => [{ sku: "ZK-JAS-001", quantity: 42 }] },
      shop,
      dryRun: true,
      logger: log,
    });

    expect(result).toEqual({ compared: 1, differences: 1, writes: 0, dryRun: true });
    expect(log.info).toHaveBeenCalledWith("voorraadverschil", {
      sku: "ZK-JAS-001", oldQuantity: 3, newQuantity: 42, dryRun: true,
    });
    expect(shop.quantities.get("ZK-JAS-001")).toBe(3);
  });

  it.each([500, 504])("breekt bij ERP HTTP %s af zonder shop te lezen of schrijven", async (status) => {
    const shop = new MemoryShop([{ sku: "SKU", quantity: 8 }]);
    const shopRead = vi.spyOn(shop, "getInventory");
    const erp = new ErpClient({
      baseUrl: "http://erp.test",
      apiKey: "test",
      fetch: vi.fn(async () => new Response(null, { status })),
    });

    await expect(syncInventory({ erp, shop, logger: silentLogger() })).rejects.toThrow(`ERP gaf HTTP ${status}`);
    expect(shopRead).not.toHaveBeenCalled();
    expect(shop.writes).toHaveLength(0);
    expect(shop.quantities.get("SKU")).toBe(8);
  });

  it("breekt bij een ERP-timeout af zonder te schrijven", async () => {
    const shop = new MemoryShop([{ sku: "SKU", quantity: 8 }]);
    const erp = new ErpClient({
      baseUrl: "http://erp.test",
      apiKey: "test",
      timeoutMs: 1,
      fetch: vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })),
    });

    await expect(syncInventory({ erp, shop, logger: silentLogger() })).rejects.toThrow("ERP timeout na 1 ms");
    expect(shop.writes).toHaveLength(0);
  });

  it("wacht Retry-After af na 429 en probeert daarna opnieuw", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(Response.json([{ sku: "SKU", quantity: 7 }]));
    const sleep = vi.fn(async () => undefined);
    const client = new ErpClient({ baseUrl: "http://erp.test", apiKey: "test", fetch: request, sleep });

    await expect(client.getInventory()).resolves.toEqual([{ sku: "SKU", quantity: 7 }]);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("begrenst een te hoge Retry-After en logt de begrenzing", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "3600" } }))
      .mockResolvedValueOnce(Response.json([{ sku: "SKU", quantity: 7 }]));
    const sleep = vi.fn(async () => undefined);
    const log = silentLogger();
    const client = new ErpClient({ baseUrl: "http://erp.test", apiKey: "test", fetch: request, sleep, logger: log });

    await client.getInventory();

    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(log.warn).toHaveBeenCalledWith("ERP Retry-After begrensd", {
      retryAfter: "3600", maximumWaitMs: 60_000,
    });
  });
});
