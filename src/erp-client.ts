import type { InventoryItem, InventorySource, SyncLogger } from "./inventory-sync";
import { logger as defaultLogger } from "./logger";

export interface ErpClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: SyncLogger;
  maxRateLimitRetries?: number;
}

export class ErpClient implements InventorySource {
  private readonly fetch: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logger: SyncLogger;

  constructor(private readonly options: ErpClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.logger = options.logger ?? defaultLogger;
  }

  async getInventory(): Promise<InventoryItem[]> {
    const retries = this.options.maxRateLimitRetries ?? 3;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.request();
      if (response.status !== 429) {
        if (!response.ok) throw new Error(`ERP gaf HTTP ${response.status}`);
        return parseInventory(await response.json());
      }
      if (attempt >= retries) throw new Error(`ERP bleef HTTP 429 geven na ${retries} retries`);

      const waitMs = parseRetryAfter(response.headers.get("retry-after"));
      this.logger.warn("ERP rate limit; wachten voor nieuwe poging", { waitMs, attempt: attempt + 1 });
      await this.sleep(waitMs);
    }
  }

  private async request(): Promise<Response> {
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetch(`${this.options.baseUrl.replace(/\/$/, "")}/inventory`, {
        headers: { "X-API-Key": this.options.apiKey },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`ERP timeout na ${timeoutMs} ms`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseRetryAfter(value: string | null): number {
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1_000 : Math.max(0, date - Date.now());
}

function parseInventory(value: unknown): InventoryItem[] {
  if (!Array.isArray(value)) throw new Error("ERP-voorraad heeft geen lijstformaat");
  return value.map((item) => {
    if (typeof item !== "object" || item === null) throw new Error("ERP-voorraad bevat een ongeldig item");
    const { sku, quantity } = item as Record<string, unknown>;
    if (typeof sku !== "string" || typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) {
      throw new Error("ERP-voorraad bevat een ongeldige SKU of hoeveelheid");
    }
    return { sku, quantity };
  });
}
