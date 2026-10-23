import type { SocialContentTaskDetail } from '../../shared/contracts/socialContentWorkflow.js';
import { writeExecutionStage } from './socialContentProductionRuntimeSupport.js';
import { createSocialContentArtifact } from './socialContentOutputs.js';
import type { SocialContentBackendFilePort } from './socialContentFiles.js';
import { STARTER_COLLECTIONS, type Starter198Repository } from './repository.js';
import { buildSocialShootingPlanArtifactContent } from './socialContentShootingPlan.js';

interface ShootingPlanExecutionInput {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  taskId: string;
  runId: string;
  now?: Date;
  backendFilePort?: SocialContentBackendFilePort;
}

/** A checklist ends at review; it must not enter video delivery or publishing. */
export async function finishShootingPlanExecution(
  input: ShootingPlanExecutionInput,
  artifactId: string,
): Promise<void> {
  await writeExecutionStage({
    ...input,
    stage: 'review_ready',
    status: 'completed',
    message: '逐镜代拍清单已生成，等待用户审核。',
    extra: { artifactId, artifactKind: 'shooting_plan' },
  });
  const run = await input.repository.get(STARTER_COLLECTIONS.runs, input.tenantId, input.runId);
  if (run) await input.repository.update(STARTER_COLLECTIONS.runs, input.tenantId, run.id, {
    status: 'completed',
    current_controller: 'system',
    pause_reason: '',
    completed_at: new Date().toISOString(),
  });
}

/** The non-rendering path creates only a reviewable artifact, with no provider calls. */
export async function createShootingPlanExecution(
  input: ShootingPlanExecutionInput,
  detail: SocialContentTaskDetail,
): Promise<void> {
  const directorBrief = detail.agentWorkflow?.directorBrief;
  if (!directorBrief) throw new Error('shooting_plan_director_brief_missing');
  await writeExecutionStage({
    ...input,
    stage: 'shooting_plan',
    message: '内容 Agent 正在把编导方案整理为逐镜代拍清单，不调用配音、数字人、IAIGC 或渲染服务。',
    extra: { directorBriefId: directorBrief.directorBriefId, sceneCount: directorBrief.scenes.length },
  });
  const artifactResult = await createSocialContentArtifact({
    repository: input.repository,
    tenantId: input.tenantId,
    userId: input.userId,
    taskId: input.taskId,
    idempotencyKey: `social-shooting-plan:${input.runId}`,
    trustedAgentOrigin: true,
    now: input.now,
    backendFilePort: input.backendFilePort,
    value: {
      kind: 'shooting_plan',
      platform: detail.brief.platforms[0] ?? null,
      language: detail.brief.languages[0] ?? null,
      origin: 'agent',
      resourceRef: null,
      content: buildSocialShootingPlanArtifactContent(detail),
    },
  });
  await finishShootingPlanExecution(input, artifactResult.artifact.artifactId);
}
