import { GoogleGenAI, type Content } from '@google/genai';
import { normalizeVisualEvidence, type CaptionOccupancy, type EmphasisEvent, type ShotWindow, type VisualEvidence } from '../../shared/contracts/emphasisTimeline.js';

export const STUDIO_VISUAL_ANALYZER_VERSION = 'studio-visual-evidence.v3';

export type StudioVisualAnalyzerInput = {
  contactSheet: Buffer;
  shotWindows: ShotWindow[];
  contactFrames: Array<{ shotId: string; timeMs: number; column: number; row: number }>;
  captionOccupancy: CaptionOccupancy[];
  candidateEvents: Array<Pick<EmphasisEvent, 'id' | 'type' | 'startMs' | 'endMs' | 'text' | 'targetId'>>;
};
export type StudioVisualAnalyzer = (input: StudioVisualAnalyzerInput) => Promise<unknown>;

const normalizedNumberJsonSchema = { type: 'number', minimum: 0, maximum: 1 } as const;
const normalizedBoxJsonSchema = {
  type: 'object',
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: normalizedNumberJsonSchema,
    y: normalizedNumberJsonSchema,
    width: normalizedNumberJsonSchema,
    height: normalizedNumberJsonSchema,
  },
} as const;

function unwrapVisualEvidence(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.shots)) return record.shots;
  if (Array.isArray(record.visualEvidence)) return record.visualEvidence;
  return [];
}

function finiteUnit(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined;
}

/** Converts broad machine detections into a local component target suitable for a small graphic. */
function localizeMachineEvidence(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const raw = value as Record<string, unknown>;
  const subjectType = String(raw.subjectType || '');
  const pointValue = raw.focalPoint && typeof raw.focalPoint === 'object' ? raw.focalPoint : raw.subjectAnchor;
  const point = pointValue && typeof pointValue === 'object' ? pointValue as Record<string, unknown> : {};
  let anchorX = finiteUnit(point.x); let anchorY = finiteUnit(point.y);
  if (subjectType !== 'machine' && subjectType !== 'process') {
    const boxValue = raw.subjectBox && typeof raw.subjectBox === 'object' ? raw.subjectBox as Record<string, unknown> : {};
    const widthValue = finiteUnit(boxValue.width); const heightValue = finiteUnit(boxValue.height);
    const broad = widthValue !== undefined && heightValue !== undefined && (widthValue > .72 || heightValue > .72 || widthValue * heightValue > .5);
    const genericCenter = anchorX !== undefined && anchorY !== undefined && Math.abs(anchorX - .5) < .03 && Math.abs(anchorY - .5) < .03;
    if (broad && genericCenter) return { ...raw, subjectBox: undefined, subjectAnchor: undefined };
    return { ...raw, ...(anchorX !== undefined && anchorY !== undefined ? { subjectAnchor: { x: anchorX, y: anchorY } } : {}) };
  }
  const box = raw.subjectBox && typeof raw.subjectBox === 'object' ? raw.subjectBox as Record<string, unknown> : {};
  const x = finiteUnit(box.x); const y = finiteUnit(box.y);
  const width = finiteUnit(box.width); const height = finiteUnit(box.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined
    || x + width > 1 || y + height > 1) return raw;
  const broad = width > .55 || height > .55 || width * height > .32;
  if (!broad) return { ...raw, ...(anchorX !== undefined && anchorY !== undefined
    ? { subjectAnchor: { x: anchorX, y: anchorY } } : {}) };

  // With no model-selected component, use an upper outer edge within the detected
  // machine instead of centering a surround effect over the whole machine body.
  anchorX ??= x + width * .82;
  anchorY ??= y + height * .32;
  anchorX = Math.min(x + width, Math.max(x, anchorX));
  anchorY = Math.min(y + height, Math.max(y, anchorY));
  const localWidth = Math.min(.2, Math.max(.12, width * .28));
  const localHeight = Math.min(.2, Math.max(.12, height * .28));
  const localX = Math.min(1 - localWidth, Math.max(0, anchorX - localWidth / 2));
  const localY = Math.min(1 - localHeight, Math.max(0, anchorY - localHeight / 2));
  return { ...raw, subjectAnchor: { x: anchorX, y: anchorY },
    subjectBox: { x: localX, y: localY, width: localWidth, height: localHeight } };
}

export function extractStudioVisualEvidenceJson(value: string): unknown[] {
  const content = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return unwrapVisualEvidence(JSON.parse(content)); } catch { return []; }
}

export async function defaultStudioVisualAnalyzer(input: StudioVisualAnalyzerInput): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return [];
  const prompt = `Analyze this single contact sheet as visual evidence only. Return exactly one JSON object with this top-level shape: {"shots":[...]}. Add one general item per visible shot and, when a candidate event clearly refers to a local visible subject, one event-scoped item carrying that eventId.
Each shots item may contain only: shotId, eventId, targetId, subjectType(person|product|machine|process|unknown), subjectBox{x,y,width,height}, focalPoint{x,y}, preferredSide(left|right|top|bottom|auto), targetRelation(surround|point_to|adjacent|none), safeZones[{x,y,width,height,clarity}], captionBoxes[{x,y,width,height}], captionText, confidence. For a machine or process, subjectBox must tightly cover one visually meaningful local component (control panel, active tool head, workpiece, moving mechanism or light source), never the entire machine. focalPoint must identify the exact component that an arrow or small highlight should point to. preferredSide is where a small graphic has usable negative space around the focal component. captionText is the exact readable on-screen caption, when present. Only emit eventId when the event text refers to a visible local subject; otherwise keep it as general shot evidence and set targetRelation to none. If no component is clear, omit focalPoint and use a tight box at a usable outer edge instead of enclosing the machine body. Keep the response compact: at most one event-scoped item per candidate event, one safe zone and one caption box per item, and omit uncertain optional geometry.
Coordinates are normalized 0..1 within the original video frame, not the contact sheet. Do not create event text, prices, product claims, business facts, or final overlay coordinates. Omit uncertain boxes. confidence must reflect visible evidence.
Shot windows: ${JSON.stringify(input.shotWindows.slice(0, 24))}
Contact cells: ${JSON.stringify(input.contactFrames.slice(0, 18))}
Known caption occupancy: ${JSON.stringify(input.captionOccupancy.slice(0, 24))}
Candidate timing context only: ${JSON.stringify(input.candidateEvents.slice(0, 8))}`;
  const contents: Content[] = [{ role: 'user', parts: [
    { text: prompt },
    { inlineData: { mimeType: 'image/jpeg', data: input.contactSheet.toString('base64') } },
  ] }];
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
    contents,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        required: ['shots'],
        properties: {
          shots: {
            type: 'array',
            items: {
              type: 'object',
              required: ['shotId', 'subjectType', 'confidence'],
              properties: {
                shotId: { type: 'string' },
                eventId: { type: 'string' },
                targetId: { type: 'string' },
                subjectType: { type: 'string', enum: ['person', 'product', 'machine', 'process', 'unknown'] },
                subjectBox: normalizedBoxJsonSchema,
                focalPoint: { type: 'object', required: ['x', 'y'], properties: {
                  x: normalizedNumberJsonSchema, y: normalizedNumberJsonSchema,
                } },
                preferredSide: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'auto'] },
                targetRelation: { type: 'string', enum: ['surround', 'point_to', 'adjacent', 'none'] },
                safeZones: { type: 'array', items: { ...normalizedBoxJsonSchema, required: ['x', 'y', 'width', 'height', 'clarity'],
                  properties: { ...normalizedBoxJsonSchema.properties, clarity: normalizedNumberJsonSchema } } },
                captionBoxes: { type: 'array', items: normalizedBoxJsonSchema },
                captionText: { type: 'string' },
                confidence: normalizedNumberJsonSchema,
              },
            },
          },
        },
      },
      maxOutputTokens: 2_000,
      thinkingConfig: { thinkingBudget: 0 },
      temperature: 0,
    },
  });
  return extractStudioVisualEvidenceJson(response.text || '');
}

/** One contact sheet, one model request, strict local normalization. */
export async function analyzeStudioVisualEvidence(
  input: StudioVisualAnalyzerInput,
  options: { analyzer?: StudioVisualAnalyzer } = {},
): Promise<VisualEvidence[]> {
  if (!input.contactSheet?.length || !input.shotWindows.length) return [];
  try {
    const raw = unwrapVisualEvidence(await (options.analyzer || defaultStudioVisualAnalyzer)(input)).map(localizeMachineEvidence);
    const knownShots = new Set(input.shotWindows.map(shot => shot.id));
    return normalizeVisualEvidence(raw).filter(item => knownShots.has(item.shotId));
  } catch {
    return [];
  }
}
