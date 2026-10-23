import type { DigitalHumanRequirements } from '../../src/lib/digitalHumanPlan.js';

export const PIPELINE3_FIRST_FRAME_PROMPT_VERSION = 'pipeline3-background-lock-v1';

export function pipeline3FirstFramePrompt(requirements?: DigitalHumanRequirements): string {
  const action = String(requirements?.action || '').trim();
  const preserve = String(requirements?.preserve || '').trim();
  return [
    '以图一为不可重绘的背景底板。完整保留图一可见的玻璃、墙面、门框、设备、实验台、货架、灯光、空间纵深、透视关系、机位和画面边缘像素。',
    '只允许在图一原人物区域内，用图二的已授权企业人物替换原人物。保持原人物的位置、身体尺度、朝向、遮挡关系和动作起点。',
    '企业人物的脸型、五官比例、发际线、肤色和年龄必须与图二一致；人物边缘与图一光线自然融合。',
    '禁止重新设计、清理、美化、扩建或移动背景；禁止把原场景改成展厅、产品柜、办公室或其他空间；禁止改变背景结构、设备位置、灯光和透视。',
    '禁止添加字幕、品牌、Logo、界面或水印。',
    action ? `首帧动作起点：${action}` : '',
    preserve ? `保留约束：${preserve}` : '',
    `质量协议：${PIPELINE3_FIRST_FRAME_PROMPT_VERSION}`,
  ].filter(Boolean).join('\n');
}
