import crypto from 'node:crypto';

/**
 * Canonical identity shared by Enterprise Center selectors and production
 * workers. Display names are intentionally excluded from task references.
 */
export function enterpriseProductIdentity(
  product: { id?: unknown; productId?: unknown; sku?: unknown; name?: unknown },
  index: number,
): string {
  const persistedId = [product.id, product.productId]
    .map(value => String(value ?? '').trim().slice(0, 200))
    .find(Boolean) ?? '';
  if (persistedId) return persistedId;
  const sku = String(product.sku ?? '').trim().slice(0, 160);
  if (sku) return sku;
  const name = String(product.name ?? '').trim().slice(0, 200);
  // Historic rows may have neither a persisted id nor SKU. Hash the normalized
  // name so reordering the product table cannot silently change task identity;
  // the index is used only for an otherwise empty legacy row.
  const hash = crypto.createHash('sha256').update(name || `legacy-empty-row:${index}`).digest('hex');
  return `product-${hash.slice(0, 16)}`;
}

/** Keep the canonical identity when an import updates the product's display data. */
export function mergeEnterpriseProductIdentity<T extends { id?: unknown; productId?: unknown; sku?: unknown; name?: unknown }>(
  existing: T,
  incoming: T,
  index: number,
): T & { id: string } {
  return {
    ...existing,
    ...incoming,
    id: enterpriseProductIdentity(existing, index),
  };
}
