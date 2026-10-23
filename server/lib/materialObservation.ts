// A visual index is not evidence of composition, performance or hidden causes.
const unverifiableClaim = /疑似|可能|无法确认|水滴|液滴|液体|油污|腐蚀|认证|耐压|防水|导电率|合格率|铜制|铝制|钢制|非水滴/;
export function groundedMaterialFacts(values: string[]) {
  return {facts:values.filter(value=>!unverifiableClaim.test(value)),review:values.filter(value=>unverifiableClaim.test(value))};
}
/** Material footage may be one continuous take. Do not impose reference-video shot density. */
export function normalizeMaterialObservations(id: string, duration: number, raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).segments)) throw Error('素材分析没有返回可用时间区间');
  let previousEnd = 0;
  return (raw as any).segments.map((item: any, index: number) => {
    const start = Number(item.start), end = Number(item.end), confidence = Number(item.confidence);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousEnd - .05 || start < 0 || end <= start || end > duration + .05) throw Error('素材分析时间区间无效，请重试分析');
    previousEnd = end;
    const observedFacts = (Array.isArray(item.observedFacts) ? item.observedFacts : []).filter((value: unknown): value is string => typeof value === 'string' && !!value.trim()).slice(0,12);
    if (!observedFacts.length) throw Error('素材分析缺少可见事实');
    const grounded = groundedMaterialFacts(observedFacts);
    const score = Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 0;
    const within = (value: unknown, fallback: number, minimum = start) => {
      const parsed = typeof value === 'number' ? value
        : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
      return Number.isFinite(parsed) ? Math.max(minimum, Math.min(end, parsed)) : fallback;
    };
    const actionStart = within(item.actionStart, start);
    const actionEnd = within(item.actionEnd, end, actionStart);
    const actionPeak = within(item.actionPeak, (actionStart + actionEnd) / 2, actionStart);
    const cleanStart = within(item.cleanStart, start);
    const cleanEnd = within(item.cleanEnd, end, cleanStart);
    const rawBoundaryConfidence = typeof item.boundaryConfidence === 'number' ? item.boundaryConfidence
      : typeof item.boundaryConfidence === 'string' && item.boundaryConfidence.trim() ? Number(item.boundaryConfidence) : Number.NaN;
    const boundaryConfidence = Number.isFinite(rawBoundaryConfidence) ? Math.max(0, Math.min(1, rawBoundaryConfidence)) : 0;
    const motionLevel = ['static', 'low', 'medium', 'high'].includes(String(item.motionLevel)) ? String(item.motionLevel) : 'unknown';
    // These are editorial retrieval labels, never claims about the product.
    // Keep them attached to this exact interval so two different shots in one
    // file cannot be combined into a fictitious two-dimensional match.
    const label = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 80) : '';
    const visualTopic = label(item.visualTopic);
    const expressionPurpose = label(item.expressionPurpose);
    return { id: `${id}-segment-${index + 1}`, start, end: Math.min(end,duration), duration: end-start,
      subject: Array.isArray(item.subject) ? item.subject.filter((value: unknown) => typeof value === 'string').slice(0,8) : [],
      action: String(item.action || ''), shot: String(item.shot || ''), angle: String(item.angle || ''), camera: String(item.camera || ''), composition: String(item.composition || ''), environment: String(item.environment || ''),
      motionLevel, actionStart, actionPeak, actionEnd, cleanStart, cleanEnd,
      cleanEntry: item.cleanEntry === true && boundaryConfidence >= .6,
      cleanExit: item.cleanExit === true && boundaryConfidence >= .6,
      boundaryConfidence,
      observedFacts: grounded.facts, excludedObservations: grounded.review, visual: grounded.facts.join('；'), confidence: score, needsReview: item.needsReview !== false || score < .65 || !grounded.facts.length,
      visualTopic, expressionPurpose,
      recommendedFunctions: expressionPurpose ? [expressionPurpose] : [], productVisible: false, productClarity: 'none', ocrText: '', quality: Math.round(score * 100), hasPerson: false, hasLogo: false, logoText: [], authenticity: '原始素材视觉分析',
    };
  });
}
