/** An explicit unseen product view cannot be recovered reliably from one KB photo. */
export function storyboardRequiresAdditionalProductView(text: string): boolean {
  return /(?:产品|商品|包装|瓶身|灯具|设备|product|packaging)[^。；;\n]{0,24}(?:背面|背部|侧面|侧边|翻转|翻过来|旋转\s*(?:180|360)\s*(?:度|°)?|完整环绕|back\s*(?:view|side)|side\s*view|turn\s*(?:around|over)|rotate\s*(?:180|360))/i.test(text)
    || /(?:背面|背部|侧面|侧边|翻转|翻过来|旋转\s*(?:180|360)\s*(?:度|°)?|完整环绕)[^。；;\n]{0,24}(?:产品|商品|包装|瓶身|灯具|设备)/i.test(text);
}

export function storyboardMissingProductViews(input: {
  description: string;
  action?: { startState?: string; beats?: string[]; endState?: string; cameraMotion?: string };
  layout?: { productView?: string; cameraAngle?: string; [key: string]: unknown };
  products: Array<{ id: string; viewCount: number }>;
}): string[] {
  const requested = [input.description, input.action?.startState || '', ...(input.action?.beats || []),
    input.action?.endState || '', input.action?.cameraMotion || '',
    `产品 ${input.layout?.productView || ''}`, `产品 ${input.layout?.cameraAngle || ''}`].join('；');
  return storyboardRequiresAdditionalProductView(requested)
    ? input.products.filter(product => product.viewCount < 2).map(product => product.id) : [];
}
