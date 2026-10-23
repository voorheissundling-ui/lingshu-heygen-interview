export interface StoryboardMatchProduct { id: string; name: string; context?: string }
export interface StoryboardProductMatch { productIds: string[]; confidence: number; reason: string; source: 'exact_name' | 'model' | 'single_selected' | 'unresolved' }

/** Match only within products explicitly selected for this video. */
export async function matchStoryboardProducts(input: {
  shotDescription: string;
  products: StoryboardMatchProduct[];
  selectWithModel?: (prompt: string) => Promise<string>;
}): Promise<StoryboardProductMatch> {
  const products = input.products.filter(item => item.id && item.name);
  if (!products.length) return { productIds: [], confidence: 0, reason: '本片未选择企业产品', source: 'unresolved' };
  if (products.length === 1) return { productIds: [products[0].id], confidence: 1, reason: '本片仅选择一款产品', source: 'single_selected' };
  const description = input.shotDescription.toLocaleLowerCase();
  const exact = products.filter(item => item.name.trim().length >= 2 && description.includes(item.name.trim().toLocaleLowerCase()));
  if (exact.length) return { productIds: exact.map(item => item.id), confidence: 0.98,
    reason: '分镜画面要求明确提及所选产品名称', source: 'exact_name' };
  if (input.selectWithModel) {
    const prompt = `你只负责把已确认分镜画面对应到本片第一步已经选择的企业产品，不要重新分析视频，不要增加产品。只根据可见画面要求判断；口播单独提及但画面未出现的产品不要选。可以选多个，也可以选空数组。候选：${JSON.stringify(products.map(item => ({ id: item.id, name: item.name, context: item.context?.slice(0, 300) || '' })))}。分镜画面要求：${JSON.stringify(input.shotDescription.slice(0, 1800))}。只返回 JSON {"productIds":["候选id"],"confidence":0到1,"reason":"一句具体依据"}。`;
    try {
      const raw = await input.selectWithModel(prompt);
      const json = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
      const parsed = JSON.parse(json) as { productIds?: unknown; confidence?: unknown; reason?: unknown };
      const ids = Array.isArray(parsed.productIds) ? [...new Set(parsed.productIds.map(String))] : [];
      const allowed = new Set(products.map(item => item.id));
      const confidence = Number(parsed.confidence);
      if (ids.every(id => allowed.has(id)) && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) {
        return { productIds: ids, confidence, reason: String(parsed.reason || '').slice(0, 300), source: 'model' };
      }
    } catch { /* unresolved is preferable to inventing a product */ }
  }
  return { productIds: [], confidence: 0, reason: '分镜未能可靠对应到已选企业产品', source: 'unresolved' };
}
