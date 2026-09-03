import { describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "./shopify-client";

describe("ShopifyClient", () => {
  it("zoekt het inventory-item zelf op voordat voorraad wordt geschreven", async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: {
        productVariants: { nodes: [{ sku: "ZK-JAS-001", inventoryItem: { id: "gid://shopify/InventoryItem/1" } }] },
      } }))
      .mockResolvedValueOnce(Response.json({ data: { inventorySetQuantities: { userErrors: [] } } }));
    const client = new ShopifyClient({
      storeDomain: "shop.test",
      accessToken: "test",
      locationId: "gid://shopify/Location/1",
      fetch: fetchImplementation,
    });

    await client.setInventory({ sku: "ZK-JAS-001", quantity: 12 });

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const lookup = JSON.parse(fetchImplementation.mock.calls[0][1].body as string) as { variables: unknown };
    expect(lookup.variables).toEqual({ query: "sku:\"ZK-JAS-001\"" });
    const mutation = JSON.parse(fetchImplementation.mock.calls[1][1].body as string) as {
      variables: { input: { quantities: unknown[] } };
    };
    expect(mutation.variables.input.quantities).toEqual([{
      inventoryItemId: "gid://shopify/InventoryItem/1",
      locationId: "gid://shopify/Location/1",
      quantity: 12,
    }]);
  });

  it("schrijft niet als de SKU niet in Shopify bestaat", async () => {
    const fetchImplementation = vi.fn(async () => Response.json({ data: { productVariants: { nodes: [] } } }));
    const client = new ShopifyClient({
      storeDomain: "shop.test",
      accessToken: "test",
      locationId: "gid://shopify/Location/1",
      fetch: fetchImplementation,
    });

    await expect(client.setInventory({ sku: "ONBEKEND", quantity: 1 }))
      .rejects.toThrow("Shopify inventory-item ontbreekt voor ONBEKEND");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
