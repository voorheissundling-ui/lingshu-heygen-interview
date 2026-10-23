export function matchedReferenceIndustryLeaks(script: string, forbidden: string[]): string[] {
  // Wardrobe in a staging field is not the advertised product. Keep spoken
  // claims and product-focused wardrobe descriptions subject to the same gate.
  const scoped = script.split('\n').map(line => {
    if (!/^\s*(构图|画面)[：:]/.test(line)
      || !/女性|男性|人物|主持人|模特|演员/.test(line)
      || /展示|推荐|主推|售卖|销售|购买|价格|面料|透气|耐用|卖点|特写|品牌|产品/.test(line)) return line;
    return line.replace(/连衣裙|t恤/gi, '日常着装');
  }).join('\n').toLowerCase();
  return forbidden.filter(term => scoped.includes(term.toLowerCase()));
}
