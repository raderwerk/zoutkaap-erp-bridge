import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

let activeServer: Server | undefined;

afterEach(async () => {
  if (activeServer) {
    await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
    activeServer = undefined;
  }
});

async function startServer(): Promise<string> {
  const app = createApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  activeServer = server;

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("kon geen poort toewijzen aan de teststerver");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("GET /health", () => {
  it("geeft status ok", async () => {
    const baseUrl = await startServer();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("GET /status", () => {
  it("geeft de servicenaam en actieve sync en orderdoorgifte", async () => {
    const baseUrl = await startServer();
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("zoutkaap-erp-bridge");
    expect(body.status).toBe("ok");
    expect(body.sync).toEqual({ enabled: true, intervalMinutes: 15 });
    expect(body.orders).toEqual({ enabled: true, webhook: "/webhooks/orders", retryAttempts: 4 });
  });
});
