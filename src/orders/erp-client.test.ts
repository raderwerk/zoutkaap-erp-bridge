import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpErpClient } from "./erp-client";

afterEach(() => vi.unstubAllGlobals());

describe("HttpErpClient", () => {
  it("aborts a hanging ERP request at its deadline", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })));
    await expect(new HttpErpClient("http://erp", "key", 5).createOrder({ lines: [{ sku: "A", quantity: 1 }] }, "173"))
      .rejects.toThrow("ERP request timed out after 5ms");
  });
});
