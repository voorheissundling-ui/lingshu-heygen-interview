type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord => value && typeof value === 'object' && !Array.isArray(value)
  ? value as UnknownRecord
  : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export type ReferenceFrameActionPrompt = {
  prompt: string;
  evidenceKind: 'verified_transitions' | 'sampled_beats' | 'static_state';
  sampleCount: number;
};

/**
 * Converts time-ordered frame observations into a production action contract.
 * Product interactions are copied only from observed transitions/beats; product
 * metadata and the intended marketing message never invent physical actions.
 */
export function referenceFrameActionPrompt(detailValue: unknown): ReferenceFrameActionPrompt {
  const detail = record(detailValue);
  const bodyMovement = text(detail.bodyMovement);
  const cameraMovement = text(detail.cameraMovement);
  const motionClass = text(detail.motionClass);
  const tempoPhases = Array.isArray(detail.tempoPhases)
    ? detail.tempoPhases.map(record).filter(item => text(item.time) && text(item.tempo) && text(item.action))
    : [];
  const tempoContract = tempoPhases.length
    ? `速度分段：${tempoPhases.map(item => `${text(item.time)} ${text(item.tempo)}，${text(item.action)}`).join('；')}`
    : '';
  const movementContract = [
    motionClass ? `表演类型：${motionClass}` : '',
    bodyMovement ? `人物位移：${bodyMovement}` : '',
    cameraMovement ? `运镜：${cameraMovement}` : '',
    tempoContract,
  ].filter(Boolean).join('；');
  const hook = record(detail.hookMotionEvidence);
  const observations = Array.isArray(hook.observations) ? hook.observations.map(record) : [];
  const verifiedTransitions = text(hook.status) === 'verified' && Array.isArray(hook.transitions)
    ? hook.transitions.map(record).filter(item => text(item.action) && Number(item.to) > Number(item.from))
    : [];
  if (verifiedTransitions.length) {
    const steps = verifiedTransitions.map(item =>
      `${Number(item.from).toFixed(2)}-${Number(item.to).toFixed(2)}s：${text(item.action)}`
    );
    return {
      prompt: `严格按抽帧证据复现人物动作顺序：${steps.join('；')}。${movementContract ? `${movementContract}。` : ''}只复现画面中可见的人物、手部、物体接触与位移，不根据产品名称补充动作。`,
      evidenceKind: 'verified_transitions',
      sampleCount: observations.length,
    };
  }

  const beats = Array.isArray(detail.beats)
    ? detail.beats.map(record).filter(item => text(item.time) && text(item.action))
    : [];
  if (beats.length) {
    return {
      prompt: `根据按时间抽取的画面组复现动作：${beats.map(item => `${text(item.time)}：${text(item.action)}`).join('；')}。${movementContract ? `${movementContract}。` : ''}保持人物空间位移、步态节奏、运镜方向、动作先后、手与产品的实际接触关系及物体终态，不添加抽帧中未出现的拿取、旋转、指向或演示动作。`,
      evidenceKind: 'sampled_beats',
      sampleCount: beats.length,
    };
  }

  const start = text(detail.startState) || text(detail.persistentState) || text(detail.observedFacts);
  return {
    prompt: start
      ? `抽帧只确认静态状态：${start}。${movementContract ? `${movementContract}。` : ''}保持画面中的静态姿态，不生成未经时间序列证实的产品交互动作。`
      : '抽帧没有提供可验证的人物动作；保持目标首帧的静态画面状态，不添加产品交互动作。',
    evidenceKind: 'static_state',
    sampleCount: 1,
  };
}
