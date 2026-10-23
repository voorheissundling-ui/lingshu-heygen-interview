import fs from 'node:fs';

type Data = Record<string, unknown>;
export interface PresenterApprovalBinding {
  tenantId: string; projectId: string; jobId: string; outputMaterialId: string;
  voiceoverUrl: string; spokenText: string; language: string;
}
const jobsFile = new URL('../../data/digital-human-jobs.json', import.meta.url);
/** Read durable approval only. Never refresh a provider or create/approve a job. */
export function readPresenterApprovalJobs(): Data[] {
  try { const value = JSON.parse(fs.readFileSync(jobsFile, 'utf8')); return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : []; }
  catch { return []; }
}
export function presenterApprovalMatches(binding: PresenterApprovalBinding, jobs: Data[], allowMachineReview = false): boolean {
  if (Object.values(binding).some(value => !value.trim())) return false;
  const job = jobs.find(item => item && item.id === binding.jobId && item.tenantId === binding.tenantId);
  if (!job || job.provider !== 'heygen' || job.projectId !== binding.projectId || !(job.status === 'completed' || (allowMachineReview && job.status === 'review'))) return false;
  const report = job.qualityReport as Data | undefined;
  return report?.passed === true && (Boolean(job.completedAt) || (allowMachineReview && job.status === 'review'))
    && job.outputMaterialId === binding.outputMaterialId
    && job.voiceoverUrl === binding.voiceoverUrl
    && job.scriptSnapshot === binding.spokenText
    && job.language === binding.language;
}
export function presenterApprovalForProject(tenantId: string, projectId: string, spec: Data, automation: Data, jobs = readPresenterApprovalJobs(), allowMachineReview = false): boolean {
  return presenterApprovalMatches({ tenantId, projectId,
    jobId: String(automation.heygenJobId || ''), outputMaterialId: String(automation.heygenOutputMaterialId || ''),
    voiceoverUrl: String(spec.voiceoverUrl || ''), spokenText: String(automation.spokenText || ''), language: String(spec.lang || ''),
  }, jobs, allowMachineReview);
}
/** An approval change permits one quality recheck, not a render or provider retry. */
export function presenterApprovalResumesQuality(automation: Data, approved: boolean): boolean {
  return automation.stage === 'blocked' && automation.resumeStage === 'quality'
    && automation.heygenApproved !== true && approved;
}
