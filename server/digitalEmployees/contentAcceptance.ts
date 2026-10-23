import { createHash } from 'node:crypto';
export function contentAcceptanceHash(spec: Record<string, any>): string {
  return createHash('sha256').update(JSON.stringify({ subtitleStyle: spec.subtitleStyle, exportSpec: spec.exportSpec, coverTitle: spec.coverTitle, coverFrameTime: spec.coverFrameTime, coverImagePath: spec.coverImagePath, bgm: spec.bgm, bgmVol: spec.bgmVol, script: spec.script, language: spec.lang, duration: spec.duration, voiceoverUrl: spec.voiceoverUrl, cues: spec.alignedCuesByLang,
    disclaimer: spec.disclaimer, presenter: spec.presenterMode, presentationMode: spec.presentationMode || spec.contentOrder?.videoPlan?.presenter, presentationSources: spec.presentationSources, reviewRequirements: spec.contentOrder?.videoPlan?.reviewRequirements, scenePlan: spec.contentOrder?.videoPlan?.scenePlan, sceneSourcePlan: spec.sceneSourcePlan, heygenJobId: spec.automation?.heygenJobId, materials: spec.selectedMaterialIds, render: spec.renderOutputPath || spec.automation?.renderOutputPath, renderedAt: spec.automation?.renderedAt, qualityVersion: spec.automation?.quality?.ruleVersion, version: spec.automation?.contentVersion })).digest('hex');
}
export function contentAccepted(spec: Record<string, any>): boolean {
  return Boolean(spec.contentAcceptance?.approvedBy && spec.contentAcceptance?.approvedAt && spec.contentAcceptance?.hash === contentAcceptanceHash(spec));
}
