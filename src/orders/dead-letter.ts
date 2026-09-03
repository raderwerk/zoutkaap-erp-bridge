import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { DeadLetterItem } from "./types";

export interface DeadLetterQueue {
  add(item: DeadLetterItem): Promise<void>;
}

/** Durable, human-readable JSON Lines queue for orders requiring intervention. */
export class JsonlDeadLetterQueue implements DeadLetterQueue {
  constructor(private readonly path: string) {}

  async add(item: DeadLetterItem): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(item)}\n`, "utf8");
  }
}
