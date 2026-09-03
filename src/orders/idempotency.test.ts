import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("separates the next record from a truncated final line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zoutkaap-idempotency-"));
    directories.push(directory);
    const path = join(directory, "orders.jsonl");
    await appendFile(path, '{"orderReference":"TORN-');
    const store = new JsonlIdempotencyStore(path);
    const claim = await store.claim("after-torn");
    await claim.lease!.complete(83);
    await expect(new JsonlIdempotencyStore(path).claim("after-torn")).resolves.toMatchObject({ state: "completed", erpOrderId: 83 });
  });

  it("lists a processing payload and reclaims its dead process lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zoutkaap-idempotency-"));
    directories.push(directory);
    const path = join(directory, "orders.jsonl");
    const order = {
      reference: "orphaned-173",
      currency: "EUR" as const,
      lines: [{ sku: "ZK-JAS-001", quantity: 1, unitPriceCents: 18_900, discountCents: 0 }],
      discountCents: 0,
      shippingCents: 695,
    };
    await writeFile(path, `${JSON.stringify({ orderReference: order.reference, state: "processing", order })}\n`);
    const lockPath = `${path}.${createHash("sha256").update(order.reference).digest("hex")}.lock`;
    await writeFile(lockPath, "999999999");

    const store = new JsonlIdempotencyStore(path);
    await expect(store.recoverableOrders()).resolves.toEqual([order]);
    await expect(store.claim(order.reference, order)).resolves.toMatchObject({ state: "claimed" });
  });

  it.each(["", "not-a-pid", "0", "-1"])("reclaims an orphaned lock containing %j", async (contents) => {
    const directory = await mkdtemp(join(tmpdir(), "zoutkaap-idempotency-"));
    directories.push(directory);
    const path = join(directory, "orders.jsonl");
    const lockPath = `${path}.${createHash("sha256").update("orphaned-lock").digest("hex")}.lock`;
    await writeFile(lockPath, contents);

    const claim = await new JsonlIdempotencyStore(path).claim("orphaned-lock");

    expect(claim.state).toBe("claimed");
    await claim.lease!.complete(84);
  });

  it("does not retry indefinitely when an orphaned lock is in a non-writable directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zoutkaap-idempotency-"));
    directories.push(directory);
    const path = join(directory, "orders.jsonl");
    const lockPath = `${path}.${createHash("sha256").update("read-only-lock").digest("hex")}.lock`;
    await writeFile(lockPath, "");
    let removalAttempts = 0;
    const readOnlyUnlink = async () => {
      removalAttempts += 1;
      throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
    };

    const claim = await new JsonlIdempotencyStore(path, readOnlyUnlink).claim("read-only-lock");

    expect(claim).toEqual({ state: "processing" });
    expect(removalAttempts).toBe(1);
  });
});
