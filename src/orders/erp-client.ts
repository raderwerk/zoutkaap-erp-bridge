import type { ErpOrderRequest } from "./types";

export interface ErpOrder {
  id: number;
}

export interface ErpClient {
  createOrder(order: ErpOrderRequest, idempotencyKey: string): Promise<ErpOrder>;
}

export class HttpErpClient implements ErpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 4_000,
  ) {}

  async createOrder(order: ErpOrderRequest, idempotencyKey: string): Promise<ErpOrder> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(order),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`ERP request timed out after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      throw new Error(`ERP returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { id?: unknown };
    if (!Number.isInteger(body.id)) throw new Error("ERP response contains no valid order id");
    return { id: body.id as number };
  }
}
