import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlIdempotencyStore } from "./idempotency";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true }))));

describe("JsonlIdempotencyStore", () => {
  it("claims atomically across instances and remembers completion after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zoutkaap-idempotency-"));
    directories.push(directory);
    const path = join(directory, "orders.jsonl");
    const first = await new JsonlIdempotencyStore(path).claim("shopify-173");
    expect(first.state).toBe("claimed");
    await expect(new JsonlIdempotencyStore(path).claim("shopify-173")).resolves.toMatchObject({ state: "processing" });
    await first.lease!.complete(81);
    await expect(new JsonlIdempotencyStore(path).claim("shopify-173")).resolves.toMatchObject({ state: "completed", erpOrderId: 81 });
  });

  it("skips a truncated JSONL line and recovers the prior durable state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zoutkaap-idempotency-"));
    directories.push(directory);
    const path = join(directory, "orders.jsonl");
    const claim = await new JsonlIdempotencyStore(path).claim("shopify-173");
    await claim.lease!.complete(82);
    await appendFile(path, '{"orderReference":"shopify-173"');
    await expect(new JsonlIdempotencyStore(path).claim("shopify-173")).resolves.toMatchObject({ state: "completed", erpOrderId: 82 });
  });
});
