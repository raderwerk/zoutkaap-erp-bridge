import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface IdempotencyStore {
  get(orderReference: string): Promise<number | undefined>;
  save(orderReference: string, erpOrderId: number): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, number>();

  async get(orderReference: string): Promise<number | undefined> {
    return this.records.get(orderReference);
  }

  async save(orderReference: string, erpOrderId: number): Promise<void> {
    this.records.set(orderReference, erpOrderId);
  }
}

/** Append-only persistence keeps duplicate protection across service restarts. */
export class JsonlIdempotencyStore implements IdempotencyStore {
  constructor(private readonly path: string) {}

  async get(orderReference: string): Promise<number | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    for (const line of contents.trim().split("\n").reverse()) {
      if (!line) continue;
      const record = JSON.parse(line) as { orderReference: string; erpOrderId: number };
      if (record.orderReference === orderReference) return record.erpOrderId;
    }
    return undefined;
  }

  async save(orderReference: string, erpOrderId: number): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify({ orderReference, erpOrderId })}\n`, "utf8");
  }
}
