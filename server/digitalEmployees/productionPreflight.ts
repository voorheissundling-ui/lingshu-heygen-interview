/** Pre-render checks use real media intervals, never the number of script rows. */
export function visualCoverageIssues(input: {
  scenes: Array<{ assetId: string; duration: number; trimStart?: number }>;
  assets: Array<{ id: string; type: 'image' | 'video'; duration: number; localPath?: string; objectKey?: string; url?: string }>;
  minimumDistinct: number;
}): string[] {
  const groups: Array<{ id: string; start: number; end: number }> = [];
  const issues: string[] = [];
  for (const [index, scene] of input.scenes.entries()) {
    const asset = input.assets.find(item => item.id === scene.assetId);
    if (!asset) { issues.push(`第 ${index + 1} 镜没有可用素材`); continue; }
    const start = asset.type === 'video' ? Number(scene.trimStart || 0) : 0;
    const end = asset.type === 'video' ? start + scene.duration : Infinity;
    if (asset.type === 'video' && (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start || end > asset.duration + 0.05)) {
      issues.push(`第 ${index + 1} 镜的视频区间超出真实素材时长`); continue;
    }
    // Overlapping intervals cannot be counted twice as different visual evidence.
    if (!groups.some(group => group.id === (asset.localPath || asset.objectKey || asset.url || asset.id) && start < group.end && end > group.start)) groups.push({ id: asset.localPath || asset.objectKey || asset.url || asset.id, start, end });
  }
  if (groups.length < input.minimumDistinct) issues.push(`分镜只有 ${groups.length} 组独立素材画面，至少需要 ${input.minimumDistinct} 组；请补充相关素材或选择同一视频中不重复的有效片段`);
  return issues;
}

export function productionFailureState(error: unknown, retryAt?: string | null) {
  const message = error instanceof Error ? error.message : String(error || '');
  const input = message.startsWith('production_input_required:');
  return {
    status: 'failed' as const,
    kind: input ? 'input' as const : 'service' as const,
    reason: input ? message.slice('production_input_required:'.length).trim()
      : retryAt ? '执行失败，系统将按重试计划恢复；其他独立任务继续。' : '执行失败，请查看任务记录后重试；其他独立任务继续。',
  };
}

export function invalidateProductionArtifacts(spec: Record<string, any>): Record<string, any> {
  const automation = typeof spec.automation === 'object' && spec.automation ? spec.automation : {};
  const previousPath = automation.renderOutputPath || spec.renderOutputPath;
  const invalidated = previousPath ? [...(spec.invalidatedRenders || []), {
    path: previousPath, contentVersion: automation.contentVersion, reason: '脚本或素材已变化，需要重新生成和验收',
  }].slice(-20) : spec.invalidatedRenders;
  return { ...spec, invalidatedRenders: invalidated, contentAcceptance: null, coverImagePath: '',
    ...(spec.scenePlanOrigin === 'director' ? { contentOrder: { ...spec.contentOrder, videoPlan: { ...spec.contentOrder?.videoPlan, scenePlan: undefined } } } : {}),
    renderOutputPath: '', languageRenderOutputs: {}, languageRenderVersions: {},
    voiceoverUrl: '', voiceoverDur: 0, alignedCuesByLang: {}, subtitleAlignmentSource: '',
    sourceSegments: [], sceneSourcePlan: [], sceneOverrides: undefined, productionDirection: undefined,
    automation: { ...automation, renderOutputPath: '', renderedAt: '', completedAt: '', quality: {},
      heygenJobId: '', heygenOutputMaterialId: '', heygenApproved: false, narrationReviewPassed: false, sceneRepairAttempts: 0, sceneRepairHistory: [] },
  };
}
