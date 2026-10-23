const LARGE_QUANTITY_PATTERN = /\b(\d[\d,]*(?:\.\d+)?)\s*(?:pcs?|pieces?|units?|sets?|bottles?|boxes?|cartons?)\b/gi;

export function hasLargeQuantity(message: string, threshold = 1000): boolean {
  for (const match of String(message || '').matchAll(LARGE_QUANTITY_PATTERN)) {
    const quantity = Number(String(match[1]).replace(/,/g, ''));
    if (Number.isFinite(quantity) && quantity >= threshold) return true;
  }
  return false;
}
