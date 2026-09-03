import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { ShopOrder } from "./types";

export interface IdempotencyLease {
  complete(erpOrderId: number): Promise<void>;
  fail(reason: string): Promise<void>;
  abandon(): Promise<void>;
}

export interface ClaimResult {
  lease?: IdempotencyLease;
  state: "claimed" | "processing" | "completed" | "failed";
  erpOrderId?: number;
}

export interface IdempotencyStore {
  claim(orderReference: string, order?: ShopOrder): Promise<ClaimResult>;
  recoverableOrders?(): Promise<ShopOrder[]>;
}

interface RecordLine {
  orderReference: string;
  state?: "processing" | "completed" | "failed";
  erpOrderId?: number;
  reason?: string;
  recordedAt?: string;
  order?: ShopOrder;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, RecordLine>();

  async claim(orderReference: string, order?: ShopOrder): Promise<ClaimResult> {
    const current = this.records.get(orderReference);
    if (current) return resultFromRecord(current);
    this.records.set(orderReference, { orderReference, state: "processing", order });
    return {
      state: "claimed",
      lease: {
        complete: async (erpOrderId) => void this.records.set(orderReference, { orderReference, state: "completed", erpOrderId }),
        fail: async (reason) => void this.records.set(orderReference, { orderReference, state: "failed", reason }),
        abandon: async () => undefined,
      },
    };
  }
}

/**
 * JSONL persistence plus an OS-visible per-order lock protects deliveries across
 * both restarts and multiple bridge processes sharing the same data directory.
 */
export class JsonlIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly path: string,
    private readonly removeLock: (path: string) => Promise<void> = unlink,
  ) {}

  async claim(orderReference: string, order?: ShopOrder): Promise<ClaimResult> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.${createHash("sha256").update(orderReference).digest("hex")}.lock`;
    const lock = await this.acquireLock(lockPath);
    if (!lock) return { state: "processing" };

    const current = await this.latest(orderReference);
    if (current?.state === "completed" || current?.state === "failed") {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
      return resultFromRecord(current);
    }

    await this.append({ orderReference, state: "processing", recordedAt: new Date().toISOString(), order });
    let released = false;
    const finish = async (record: RecordLine) => {
      if (released) return;
      await this.append({ ...record, orderReference, recordedAt: new Date().toISOString() });
      released = true;
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    };
    const abandon = async () => {
      if (released) return;
      released = true;
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    };
    return {
      state: "claimed",
      lease: {
        complete: (erpOrderId) => finish({ orderReference, state: "completed", erpOrderId }),
        fail: (reason) => finish({ orderReference, state: "failed", reason }),
        abandon,
      },
    };
  }

  /** Returns payloads whose latest durable state is still processing.
   * `claim` performs the authoritative live-owner check when they are enqueued.
   */
  async recoverableOrders(): Promise<ShopOrder[]> {
    const latest = new Map<string, RecordLine>();
    for (const line of await this.lines()) {
      try {
        const record = JSON.parse(line) as RecordLine;
        if (record.orderReference) latest.set(record.orderReference, record);
      } catch {
        // Ignore a write interrupted between bytes; subsequent records still parse.
      }
    }
    return [...latest.values()]
      .filter((record): record is RecordLine & { order: ShopOrder } => record.state === "processing" && record.order !== undefined)
      .map((record) => record.order);
  }

  private async acquireLock(lockPath: string, mayRecover = true): Promise<FileHandle | undefined> {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid), "utf8");
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const contents = await readFile(lockPath, "utf8");
        const owner = Number(contents);
        if (!contents.trim() || !Number.isInteger(owner) || owner <= 0) {
          return this.recoverLock(lockPath, mayRecover);
        }
        process.kill(owner, 0);
        return undefined;
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "EPERM") return undefined;
        return this.recoverLock(lockPath, mayRecover);
      }
    }
  }

  private async recoverLock(lockPath: string, mayRecover: boolean): Promise<FileHandle | undefined> {
    if (!mayRecover) return undefined;
    try {
      await this.removeLock(lockPath);
    } catch {
      // A lock that cannot be removed must be treated as owned. Retrying the
      // unchanged filesystem state would otherwise create an unbounded loop.
      return undefined;
    }
    return this.acquireLock(lockPath, false);
  }

  private async latest(orderReference: string): Promise<RecordLine | undefined> {
    const lines = await this.lines();
    for (const line of lines.reverse()) {
      try {
        const record = JSON.parse(line) as RecordLine;
        if (record.orderReference === orderReference) return record;
      } catch {
        // A process can die halfway through a write. Other valid records remain useful.
      }
    }
    return undefined;
  }

  private async lines(): Promise<string[]> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return contents.split("\n").filter((line) => line.trim());
  }

  private async append(record: RecordLine): Promise<void> {
    // appendFile uses one O_APPEND write, so separate processes cannot overwrite one another.
    // A leading newline separates this record even if a killed process left a
    // partial final line. O_APPEND keeps the complete record together.
    await appendFile(this.path, `\n${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  }
}

function resultFromRecord(record: RecordLine): ClaimResult {
  const state = record.state ?? "completed"; // backwards compatibility with the original JSONL format
  return { state, erpOrderId: record.erpOrderId };
}
