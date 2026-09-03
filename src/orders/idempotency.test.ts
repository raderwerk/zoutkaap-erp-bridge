import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlIdempotencyStore } from "./idempotency";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("JsonlIdempotencyStore", () => {
  it("herkent een order na een herstart met een nieuwe store-instantie", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zoutkaap-idempotency-"));
    directories.push(directory);
    const path = join(directory, "orders.jsonl");

    await new JsonlIdempotencyStore(path).save("shopify-173", 81);

    await expect(new JsonlIdempotencyStore(path).get("shopify-173")).resolves.toBe(81);
    await expect(new JsonlIdempotencyStore(path).get("unknown")).resolves.toBeUndefined();
  });
});
