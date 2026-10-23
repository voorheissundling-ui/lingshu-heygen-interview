export interface ProductSearchTerm {
  term: string;
  sourceQuote: string;
  reason: string;
}
export interface ProductKeywordRecommendation {
  broadTerms: ProductSearchTerm[];
  mediumTerms: ProductSearchTerm[];
  perspective: 'factory' | 'supplier' | 'consumer';
  sourceName: string;
  sourceRefs?: string[];
}
/** Older scopes stored complete product titles as one query per discovery seed. */
export function hasLegacyProductTitleQueries(seeds: Array<{ label: string; queryVariants: string[] }>): boolean {
  const queries = seeds.flatMap(seed => seed.queryVariants.map(value => value.trim()).filter(Boolean));
  const identicalSeeds = seeds.length > 1 && seeds.every(seed => seed.queryVariants.length === 1
    && seed.queryVariants[0]?.trim() === seed.label.trim());
  const brandedTitles = queries.length > 1 && queries.every(query => /^([A-Z][A-Z0-9_-]{2,})\s*[^\x00-\x7F]/.test(query))
    && new Set(queries.map(query => query.match(/^([A-Z][A-Z0-9_-]{2,})/)?.[1])).size === 1;
  return identicalSeeds || brandedTitles;
}
export function fiveProductKeywords(value: ProductKeywordRecommendation): string[] {
  if (value.broadTerms.length !== 2 || value.mediumTerms.length !== 3) throw new Error('必须包含 2 个大词和 3 个中词');
  const terms = [...value.broadTerms, ...value.mediumTerms].map(row => row.term.trim());
  if (terms.some(term => !term || term.length > 80 || /[\n,，;；|#]/.test(term)) || new Set(terms.map(term => term.toLowerCase())).size !== 5) throw new Error('搜索词必须简短、独立且不重复');
  return terms;
}
