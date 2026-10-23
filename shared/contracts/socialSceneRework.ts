export interface SocialProductionWorkspaceBinding {
  type: 'social_production_workspace'; version: 1;
  tenantId: string; taskId: string; runId: string; artifactId: string; artifactContentHash: string;
  projectId: string; projectVersion: 1; specHash: string; baselineHash: string;
  sceneMappings: Array<{ sceneId: string; slotId: string; mediaFileRef: string; mediaSha256: string }>;
  recordHash: string;
}
export interface SocialSceneReworkAvailability {
  productionWorkspaceBinding?: SocialProductionWorkspaceBinding | null;
  productionWorkspaceGap?: string | null;
  tenantId: string;
  taskId: string;
  sourceRunId: string;
  parentArtifactId: string;
  parentArtifactHash: string;
  cacheHash: string;
  scenes: Array<{ sceneId: string; shotId: string; referenceShotId: string | null;
    sourceTiming: { startSeconds: number; endSeconds: number; durationSeconds: number } | null;
    status: 'passed' | 'failed' | 'review_required'; technicalReceiptId: string;
    checks?: Array<{ code: string; passed: boolean; message: string }> }>;
  canRequest: boolean;
  blockingReasons: string[];
  existingOperations?: SocialSceneReworkStatus[];
}

export interface SocialSceneReworkStatus {
  tenantId: string;
  taskId: string;
  operationId: string;
  sourceRunId: string;
  executionRunId: string;
  parentArtifactId: string;
  affectedSceneIds: string[];
  jobId: string;
  jobStatus: string;
  runStatus: string;
  lastError: string | null;
  completedAt?: string | null;
  runCompletedAt?: string | null;
  output?: { artifactId: string; fileRef: string; sha256: string; parentArtifactId: string;
    reviewStatus: 'review_required' | 'changes_requested'; qualityReceiptIds: string[]; savedAt: string } | null;
}
