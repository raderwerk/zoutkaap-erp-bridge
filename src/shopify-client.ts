import type { InventoryItem, InventoryTarget } from "./inventory-sync";

interface ShopifyNode {
  sku: string;
  inventoryItem: { id: string; inventoryLevel: { quantities: Array<{ quantity: number }> } | null };
}

export class ShopifyClient implements InventoryTarget {
  private inventoryItemIds = new Map<string, string>();

  constructor(private readonly options: {
    storeDomain: string;
    accessToken: string;
    locationId: string;
    apiVersion?: string;
    fetch?: typeof fetch;
  }) {}

  async getInventory(): Promise<InventoryItem[]> {
    const items: InventoryItem[] = [];
    let cursor: string | null = null;
    do {
      const data: {
        productVariants: { nodes: ShopifyNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await this.graphql(`query Inventory($cursor: String, $location: ID!) {
        productVariants(first: 100, after: $cursor) {
          nodes { sku inventoryItem { id inventoryLevel(locationId: $location) { quantities(names: ["available"]) { quantity } } } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { cursor, location: this.options.locationId });
      for (const node of data.productVariants.nodes) {
        if (!node.sku || node.inventoryItem.inventoryLevel === null) continue;
        this.inventoryItemIds.set(node.sku, node.inventoryItem.id);
        items.push({ sku: node.sku, quantity: node.inventoryItem.inventoryLevel.quantities[0]?.quantity ?? 0 });
      }
      cursor = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
    } while (cursor !== null);
    return items;
  }

  async setInventory(item: InventoryItem): Promise<void> {
    const inventoryItemId = this.inventoryItemIds.get(item.sku) ?? await this.getInventoryItemId(item.sku);
    if (inventoryItemId === undefined) throw new Error(`Shopify inventory-item ontbreekt voor ${item.sku}`);
    const data = await this.graphql<{
      inventorySetQuantities: { userErrors: Array<{ field: string[]; message: string }> };
    }>(`mutation SetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) { userErrors { field message } }
    }`, { input: {
      name: "available",
      reason: "correction",
      ignoreCompareQuantity: true,
      quantities: [{ inventoryItemId, locationId: this.options.locationId, quantity: item.quantity }],
    } });
    const errors = data.inventorySetQuantities.userErrors;
    if (errors.length > 0) throw new Error(`Shopify weigerde voorraad voor ${item.sku}: ${errors.map((e) => e.message).join(", ")}`);
  }

  private async getInventoryItemId(sku: string): Promise<string | undefined> {
    const data = await this.graphql<{ productVariants: { nodes: Array<{ sku: string; inventoryItem: { id: string } }> } }>(
      `query InventoryItemBySku($query: String!) {
        productVariants(first: 10, query: $query) { nodes { sku inventoryItem { id } } }
      }`,
      { query: `sku:${JSON.stringify(sku)}` },
    );
    const inventoryItemId = data.productVariants.nodes.find((node) => node.sku === sku)?.inventoryItem.id;
    if (inventoryItemId !== undefined) this.inventoryItemIds.set(sku, inventoryItemId);
    return inventoryItemId;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    const version = this.options.apiVersion ?? "2026-07";
    const response = await fetchImplementation(
      `https://${this.options.storeDomain}/admin/api/${version}/graphql.json`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": this.options.accessToken },
        body: JSON.stringify({ query, variables }),
      },
    );
    if (!response.ok) throw new Error(`Shopify gaf HTTP ${response.status}`);
    const body = await response.json() as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length || body.data === undefined) {
      throw new Error(`Shopify GraphQL-fout: ${body.errors?.map((error) => error.message).join(", ") ?? "data ontbreekt"}`);
    }
    return body.data;
  }
}
