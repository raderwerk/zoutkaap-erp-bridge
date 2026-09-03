import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

export interface IdempotencyLease {
  complete(erpOrderId: number): Promise<void>;
  fail(reason: string): Promise<void>;
}

export interface ClaimResult {
  lease?: IdempotencyLease;
  state: "claimed" | "processing" | "completed" | "failed";
  erpOrderId?: number;
}

export interface IdempotencyStore {
  claim(orderReference: string): Promise<ClaimResult>;
}

interface RecordLine {
  orderReference: string;
  state?: "processing" | "completed" | "failed";
  erpOrderId?: number;
  reason?: string;
  recordedAt?: string;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, RecordLine>();

  async claim(orderReference: string): Promise<ClaimResult> {
    const current = this.records.get(orderReference);
    if (current) return resultFromRecord(current);
    this.records.set(orderReference, { orderReference, state: "processing" });
    return {
      state: "claimed",
      lease: {
        complete: async (erpOrderId) => void this.records.set(orderReference, { orderReference, state: "completed", erpOrderId }),
        fail: async (reason) => void this.records.set(orderReference, { orderReference, state: "failed", reason }),
      },
    };
  }
}

/**
 * JSONL persistence plus an OS-visible per-order lock protects deliveries across
 * both restarts and multiple bridge processes sharing the same data directory.
 */
export class JsonlIdempotencyStore implements IdempotencyStore {
  constructor(private readonly path: string) {}

  async claim(orderReference: string): Promise<ClaimResult> {
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

    await this.append({ orderReference, state: "processing", recordedAt: new Date().toISOString() });
    let released = false;
    const finish = async (record: RecordLine) => {
      if (released) return;
      await this.append({ ...record, orderReference, recordedAt: new Date().toISOString() });
      released = true;
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    };
    return {
      state: "claimed",
      lease: {
        complete: (erpOrderId) => finish({ orderReference, state: "completed", erpOrderId }),
        fail: (reason) => finish({ orderReference, state: "failed", reason }),
      },
    };
  }

  private async acquireLock(lockPath: string): Promise<FileHandle | undefined> {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(String(process.pid), "utf8");
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(await readFile(lockPath, "utf8"));
        if (Number.isInteger(owner)) process.kill(owner, 0);
        return undefined;
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code === "EPERM") return undefined;
        await unlink(lockPath).catch(() => undefined);
        return this.acquireLock(lockPath);
      }
    }
  }

  private async latest(orderReference: string): Promise<RecordLine | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    for (const line of contents.split("\n").reverse()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as RecordLine;
        if (record.orderReference === orderReference) return record;
      } catch {
        // A process can die halfway through its last write. Older valid records remain useful.
      }
    }
    return undefined;
  }

  private async append(record: RecordLine): Promise<void> {
    // appendFile uses one O_APPEND write, so separate processes cannot overwrite one another.
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  }
}

function resultFromRecord(record: RecordLine): ClaimResult {
  const state = record.state ?? "completed"; // backwards compatibility with the original JSONL format
  return { state, erpOrderId: record.erpOrderId };
}
