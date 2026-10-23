import {
  SOCIAL_CONTENT_THEME_IDS,
  type SocialContentThemeId,
} from '../../shared/contracts/socialContentWorkflow.js';
import { STARTER_COLLECTIONS, type Starter198Repository, type StarterRecord } from './repository.js';
import {
  INTERNAL_SOCIAL_CONTENT_FORMULAS,
  initialMaterialRequirements,
  type InternalFormulaNode,
  type InternalSocialContentFormula,
  type InternalSocialContentFormulaDirection,
} from './socialContentThemes.js';
import {
  SocialContentWorkflowError,
  socialJson,
  socialObject,
  socialPublicId,
  socialText,
} from './socialContentValidation.js';

type FormulaStatus = InternalSocialContentFormula['status'];

const FORMULA_SCHEMA = 'social-content-formula.v2';
const READABLE_FORMULA_SCHEMAS = new Set(['social-content-formula.v1', FORMULA_SCHEMA]);
const FORMULA_STATUSES: readonly FormulaStatus[] = ['draft', 'internal_trial', 'gray', 'active', 'disabled'];
/** Platform-owned scope; customer tenants can select eligible versions but cannot read this store. */
export const SOCIAL_FORMULA_CATALOG_TENANT = '__starter_social_formula_catalog__';

function requiredText(value: unknown, code: string, maximum: number): string {
  const parsed = socialText(value);
  if (!parsed || parsed.length > maximum || /[\u0000-\u001f]/.test(parsed)) {
    throw new SocialContentWorkflowError(code, 400);
  }
  return parsed;
}

function formulaKey(value: unknown, code: string): string {
  const parsed = socialText(value);
  if (!/^[a-z][a-z0-9._-]{1,119}$/i.test(parsed)) throw new SocialContentWorkflowError(code, 400);
  return parsed;
}

function semanticVersion(value: unknown): string {
  const parsed = socialText(value);
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(parsed)) {
    throw new SocialContentWorkflowError('social_content_formula_version_invalid', 400);
  }
  return parsed;
}

function stringList(value: unknown, code: string, maximum = 200): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some(item => !socialText(item) || socialText(item).length > 200)) {
    throw new SocialContentWorkflowError(code, 400);
  }
  return [...new Set(value.map(socialText))];
}

function parseRollout(value: unknown, fallback?: InternalSocialContentFormula['rollout']): InternalSocialContentFormula['rollout'] {
  if (value === undefined) return fallback ?? { percentage: 0, tenantAllowlist: [] };
  const row = socialObject(value);
  const percentage = Number(row?.percentage);
  if (!row || Object.keys(row).some(key => !['percentage', 'tenantAllowlist'].includes(key))
    || !Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new SocialContentWorkflowError('social_content_formula_rollout_invalid', 400);
  }
  return {
    percentage,
    tenantAllowlist: stringList(row.tenantAllowlist, 'social_content_formula_rollout_invalid'),
  };
}

const FORMULA_TEMPLATE_TOKENS = new Set([
  'product', 'topic', 'callToAction', 'shotFunction', 'subject', 'action',
]);

function parseLocalizedTemplate(value: unknown): { zh: string; en: string } | undefined {
  if (value === undefined) return undefined;
  const row = socialObject(value);
  if (!row || Object.keys(row).some(key => !['zh', 'en'].includes(key))) {
    throw new SocialContentWorkflowError('social_content_formula_script_template_invalid', 400);
  }
  const template = {
    zh: requiredText(row.zh, 'social_content_formula_script_template_invalid', 1_000),
    en: requiredText(row.en, 'social_content_formula_script_template_invalid', 1_000),
  };
  for (const valueText of Object.values(template)) {
    const tokens = [...valueText.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]!);
    if (tokens.some(token => !FORMULA_TEMPLATE_TOKENS.has(token))) {
      throw new SocialContentWorkflowError('social_content_formula_script_template_invalid', 400);
    }
  }
  return template;
}

function parseDirection(value: unknown): InternalSocialContentFormula['direction'] {
  if (value === undefined) return undefined;
  const row = socialObject(value);
  if (!row || Object.keys(row).some(key => ![
    'pace', 'visualStyle', 'music', 'voiceover', 'subtitles', 'cover', 'materialFallback', 'risks', 'acceptanceGates',
  ].includes(key))) {
    throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
  }
  const parsed: InternalSocialContentFormulaDirection = {};
  if (row.pace !== undefined) {
    const pace = socialText(row.pace);
    if (!['fast', 'balanced', 'steady'].includes(pace)) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    parsed.pace = pace as NonNullable<InternalSocialContentFormulaDirection['pace']>;
  }
  if (row.visualStyle !== undefined) parsed.visualStyle = requiredText(row.visualStyle, 'social_content_formula_direction_invalid', 500);

  if (row.music !== undefined) {
    const music = socialObject(row.music);
    if (!music || Object.keys(music).some(key => ![
      'mood', 'volume', 'strategy', 'sourceType', 'licenseVerified', 'licenseReference',
    ].includes(key))) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    const parsedMusic: NonNullable<InternalSocialContentFormulaDirection['music']> = {};
    if (music.mood !== undefined) parsedMusic.mood = requiredText(music.mood, 'social_content_formula_direction_invalid', 160);
    if (music.volume !== undefined) {
      const volume = Number(music.volume);
      if (!Number.isFinite(volume) || volume < 0 || volume > 100) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      parsedMusic.volume = volume;
    }
    if (music.strategy !== undefined) parsedMusic.strategy = requiredText(music.strategy, 'social_content_formula_direction_invalid', 500);
    if (music.sourceType !== undefined) {
      const sourceType = socialText(music.sourceType);
      if (!['licensed_library', 'original', 'none'].includes(sourceType)) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      parsedMusic.sourceType = sourceType as NonNullable<typeof parsedMusic.sourceType>;
    }
    if (music.licenseVerified !== undefined) {
      if (typeof music.licenseVerified !== 'boolean') throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      parsedMusic.licenseVerified = music.licenseVerified;
    }
    if (music.licenseReference !== undefined) {
      parsedMusic.licenseReference = music.licenseReference === null
        ? null
        : requiredText(music.licenseReference, 'social_content_formula_direction_invalid', 500);
    }
    parsed.music = parsedMusic;
  }

  if (row.voiceover !== undefined) {
    const voiceover = socialObject(row.voiceover);
    if (!voiceover || Object.keys(voiceover).some(key => !['voice', 'preset', 'speed', 'pauseStyle'].includes(key))) {
      throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    }
    const parsedVoiceover: NonNullable<InternalSocialContentFormulaDirection['voiceover']> = {};
    if (voiceover.voice !== undefined) parsedVoiceover.voice = requiredText(voiceover.voice, 'social_content_formula_direction_invalid', 80);
    if (voiceover.preset !== undefined) {
      const preset = socialText(voiceover.preset);
      if (!['tiktok_excited', 'authentic_review', 'professional_b2b', 'warm_story', 'urgent_cta'].includes(preset)) {
        throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      }
      parsedVoiceover.preset = preset as NonNullable<typeof parsedVoiceover.preset>;
    }
    if (voiceover.speed !== undefined) {
      const speed = Number(voiceover.speed);
      if (!Number.isFinite(speed) || speed < 0.75 || speed > 1.5) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      parsedVoiceover.speed = speed;
    }
    if (voiceover.pauseStyle !== undefined) {
      const pauseStyle = socialText(voiceover.pauseStyle);
      if (!['few', 'natural', 'dramatic'].includes(pauseStyle)) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      parsedVoiceover.pauseStyle = pauseStyle as NonNullable<typeof parsedVoiceover.pauseStyle>;
    }
    parsed.voiceover = parsedVoiceover;
  }

  if (row.subtitles !== undefined) {
    const subtitles = socialObject(row.subtitles);
    if (!subtitles || Object.keys(subtitles).some(key => !['fontScale', 'bottomRatio', 'styleIntent'].includes(key))) {
      throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    }
    const parsedSubtitles: NonNullable<InternalSocialContentFormulaDirection['subtitles']> = {};
    if (subtitles.fontScale !== undefined) {
      const fontScale = Number(subtitles.fontScale);
      if (!Number.isFinite(fontScale) || fontScale < 0.75 || fontScale > 1.5) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      parsedSubtitles.fontScale = fontScale;
    }
    if (subtitles.bottomRatio !== undefined) {
      const bottomRatio = Number(subtitles.bottomRatio);
      if (!Number.isFinite(bottomRatio) || bottomRatio < 0.08 || bottomRatio > 0.35) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      parsedSubtitles.bottomRatio = bottomRatio;
    }
    if (subtitles.styleIntent !== undefined) parsedSubtitles.styleIntent = requiredText(subtitles.styleIntent, 'social_content_formula_direction_invalid', 300);
    parsed.subtitles = parsedSubtitles;
  }

  if (row.cover !== undefined) {
    const cover = socialObject(row.cover);
    if (!cover || Object.keys(cover).some(key => !['intent', 'headlineTemplate', 'subject', 'composition'].includes(key))) {
      throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    }
    parsed.cover = {
      ...(cover.intent !== undefined ? { intent: requiredText(cover.intent, 'social_content_formula_direction_invalid', 500) } : {}),
      ...(cover.headlineTemplate !== undefined ? { headlineTemplate: parseLocalizedTemplate(cover.headlineTemplate)! } : {}),
      ...(cover.subject !== undefined ? { subject: requiredText(cover.subject, 'social_content_formula_direction_invalid', 300) } : {}),
      ...(cover.composition !== undefined ? { composition: requiredText(cover.composition, 'social_content_formula_direction_invalid', 500) } : {}),
    };
  }

  if (row.materialFallback !== undefined) {
    const fallback = socialObject(row.materialFallback);
    if (!fallback || Object.keys(fallback).some(key => ![
      'minimumUsableClips', 'allowStillFrames', 'allowRepeatedClips', 'maxRepeatCount', 'insufficientMaterialAction',
    ].includes(key))) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    const parsedFallback: NonNullable<InternalSocialContentFormulaDirection['materialFallback']> = {};
    for (const key of ['minimumUsableClips', 'maxRepeatCount'] as const) {
      if (fallback[key] !== undefined) {
        const count = Number(fallback[key]);
        if (!Number.isSafeInteger(count) || count < 0 || count > 12) throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
        parsedFallback[key] = count;
      }
    }
    for (const key of ['allowStillFrames', 'allowRepeatedClips'] as const) {
      if (fallback[key] !== undefined) {
        if (typeof fallback[key] !== 'boolean') throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
        parsedFallback[key] = fallback[key];
      }
    }
    if (fallback.insufficientMaterialAction !== undefined) {
      const action = socialText(fallback.insufficientMaterialAction);
      if (!['adapt_with_verified_assets', 'request_reshoot', 'block'].includes(action)) {
        throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      }
      parsedFallback.insufficientMaterialAction = action as NonNullable<typeof parsedFallback.insufficientMaterialAction>;
    }
    parsed.materialFallback = parsedFallback;
  }

  if (row.risks !== undefined) {
    const risks = socialObject(row.risks);
    if (!risks || Object.keys(risks).some(key => !['prohibitedClaims', 'prohibitedVisuals', 'mandatoryDisclosures'].includes(key))) {
      throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    }
    parsed.risks = {
      ...(risks.prohibitedClaims !== undefined ? { prohibitedClaims: stringList(risks.prohibitedClaims, 'social_content_formula_direction_invalid', 50) } : {}),
      ...(risks.prohibitedVisuals !== undefined ? { prohibitedVisuals: stringList(risks.prohibitedVisuals, 'social_content_formula_direction_invalid', 50) } : {}),
      ...(risks.mandatoryDisclosures !== undefined ? { mandatoryDisclosures: stringList(risks.mandatoryDisclosures, 'social_content_formula_direction_invalid', 50) } : {}),
    };
  }

  if (row.acceptanceGates !== undefined) {
    if (!Array.isArray(row.acceptanceGates) || row.acceptanceGates.length > 20) {
      throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    }
    parsed.acceptanceGates = row.acceptanceGates.map(value => {
      const gate = socialObject(value);
      if (!gate || Object.keys(gate).some(key => !['gateId', 'name', 'rule', 'blocking'].includes(key)) || typeof gate.blocking !== 'boolean') {
        throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
      }
      return {
        gateId: formulaKey(gate.gateId, 'social_content_formula_direction_invalid'),
        name: requiredText(gate.name, 'social_content_formula_direction_invalid', 160),
        rule: requiredText(gate.rule, 'social_content_formula_direction_invalid', 1_000),
        blocking: gate.blocking,
      };
    });
    if (new Set(parsed.acceptanceGates.map(gate => gate.gateId)).size !== parsed.acceptanceGates.length) {
      throw new SocialContentWorkflowError('social_content_formula_direction_invalid', 400);
    }
  }
  return parsed;
}

function parseNodes(value: unknown): InternalFormulaNode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) {
    throw new SocialContentWorkflowError('social_content_formula_nodes_invalid', 400);
  }
  const nodes = value.map(item => {
    const row = socialObject(item);
    if (!row || Object.keys(row).some(key => ![
      'nodeId', 'shotFunction', 'subject', 'action', 'environment', 'orientation', 'durationSeconds', 'required',
      'narrationTemplate', 'scriptTemplate', 'voiceoverTemplate', 'captionTemplate',
      'shotType', 'shotSize', 'cameraMovement', 'composition', 'transition',
    ].includes(key))) throw new SocialContentWorkflowError('social_content_formula_nodes_invalid', 400);
    const orientation = row.orientation === undefined ? undefined : socialText(row.orientation);
    const duration = row.durationSeconds === undefined || row.durationSeconds === null
      ? row.durationSeconds : socialObject(row.durationSeconds);
    const minimum = duration && typeof duration === 'object' ? Number(duration.minimum) : null;
    const maximum = duration && typeof duration === 'object' ? Number(duration.maximum) : null;
    if ((orientation !== undefined && !['portrait', 'landscape', 'either'].includes(orientation))
      || (duration && (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum! < 0 || maximum! < minimum! || maximum! > 600))
      || (row.required !== undefined && typeof row.required !== 'boolean')) {
      throw new SocialContentWorkflowError('social_content_formula_nodes_invalid', 400);
    }
    const enumField = <T extends string>(field: unknown, allowed: readonly string[]): T | undefined => {
      if (field === undefined) return undefined;
      const parsed = socialText(field);
      if (!allowed.includes(parsed)) throw new SocialContentWorkflowError('social_content_formula_nodes_invalid', 400);
      return parsed as T;
    };
    return {
      nodeId: formulaKey(row.nodeId, 'social_content_formula_node_id_invalid'),
      ...(row.shotFunction !== undefined ? { shotFunction: requiredText(row.shotFunction, 'social_content_formula_nodes_invalid', 200) } : {}),
      ...(row.subject !== undefined ? { subject: requiredText(row.subject, 'social_content_formula_nodes_invalid', 200) } : {}),
      ...(row.action !== undefined ? { action: requiredText(row.action, 'social_content_formula_nodes_invalid', 200) } : {}),
      ...(row.environment !== undefined ? { environment: row.environment === null ? null : requiredText(row.environment, 'social_content_formula_nodes_invalid', 300) } : {}),
      ...(orientation !== undefined ? { orientation: orientation as NonNullable<InternalFormulaNode['orientation']> } : {}),
      ...(row.durationSeconds !== undefined ? { durationSeconds: duration ? { minimum: minimum!, maximum: maximum! } : null } : {}),
      ...(row.required !== undefined ? { required: row.required } : {}),
      ...(row.shotType !== undefined ? { shotType: enumField<NonNullable<InternalFormulaNode['shotType']>>(row.shotType, ['live_action', 'product_demo', 'process', 'talking_head', 'graphic']) } : {}),
      ...(row.shotSize !== undefined ? { shotSize: enumField<NonNullable<InternalFormulaNode['shotSize']>>(row.shotSize, ['extreme_close_up', 'close_up', 'medium', 'wide', 'detail']) } : {}),
      ...(row.cameraMovement !== undefined ? { cameraMovement: enumField<NonNullable<InternalFormulaNode['cameraMovement']>>(row.cameraMovement, ['static', 'pan', 'tilt', 'push_in', 'pull_out', 'tracking', 'handheld']) } : {}),
      ...(row.composition !== undefined ? { composition: requiredText(row.composition, 'social_content_formula_nodes_invalid', 500) } : {}),
      ...(row.transition !== undefined ? { transition: enumField<NonNullable<InternalFormulaNode['transition']>>(row.transition, ['cut', 'match_cut', 'dissolve', 'fade', 'wipe']) } : {}),
      ...(row.narrationTemplate !== undefined ? { narrationTemplate: parseLocalizedTemplate(row.narrationTemplate)! } : {}),
      ...(row.scriptTemplate !== undefined ? { scriptTemplate: parseLocalizedTemplate(row.scriptTemplate)! } : {}),
      ...(row.voiceoverTemplate !== undefined ? { voiceoverTemplate: parseLocalizedTemplate(row.voiceoverTemplate)! } : {}),
      ...(row.captionTemplate !== undefined ? { captionTemplate: parseLocalizedTemplate(row.captionTemplate)! } : {}),
    };
  });
  if (new Set(nodes.map(item => item.nodeId)).size !== nodes.length) {
    throw new SocialContentWorkflowError('social_content_formula_nodes_invalid', 400);
  }
  return nodes;
}

function parseStoredFormula(record: StarterRecord): InternalSocialContentFormula | null {
  const plan = socialObject(socialJson(record.plan));
  if (!plan || !READABLE_FORMULA_SCHEMAS.has(socialText(plan.schemaVersion))) return null;
  const formula = socialObject(plan.formula);
  const themeId = socialText(formula?.themeId) as SocialContentThemeId;
  const status = socialText(record.status) as FormulaStatus;
  const auditValue = socialJson(formula?.audit);
  if (!formula || !SOCIAL_CONTENT_THEME_IDS.includes(themeId) || !FORMULA_STATUSES.includes(status)
    || !Array.isArray(auditValue)) {
    throw new SocialContentWorkflowError('social_content_formula_record_invalid', 503);
  }
  const audit = auditValue.map(item => {
    const row = socialObject(item);
    if (!row || !socialText(row.event) || !socialText(row.actor) || !socialText(row.at)) {
      throw new SocialContentWorkflowError('social_content_formula_record_invalid', 503);
    }
    return {
      event: socialText(row.event), actor: socialText(row.actor), at: socialText(row.at),
      ...(socialText(row.note) ? { note: socialText(row.note) } : {}),
    };
  });
  return {
    recordId: record.id,
    formulaId: formulaKey(formula.formulaId, 'social_content_formula_record_invalid'),
    version: semanticVersion(formula.version),
    name: requiredText(formula.name, 'social_content_formula_record_invalid', 160),
    themeId,
    status,
    rollout: parseRollout(formula.rollout),
    direction: parseDirection(formula.direction),
    audit,
    nodes: parseNodes(formula.nodes),
  };
}

async function formulaRows(repository: Starter198Repository, tenantId: string): Promise<StarterRecord[]> {
  const first = await repository.list(STARTER_COLLECTIONS.plans, tenantId, { sort: '-created_at', page: 1, perPage: 500 });
  if (first.totalItems > 10_000) throw new SocialContentWorkflowError('social_content_formula_registry_scan_limit_exceeded', 503);
  const rows = [...first.items];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const next = await repository.list(STARTER_COLLECTIONS.plans, tenantId, { sort: '-created_at', page, perPage: 500 });
    rows.push(...next.items);
  }
  if (rows.length !== first.totalItems) throw new SocialContentWorkflowError('social_content_formula_registry_integrity_violation', 503);
  return rows.filter(record => READABLE_FORMULA_SCHEMAS.has(socialText(socialObject(socialJson(record.plan))?.schemaVersion)));
}

function completeLocalizedTemplate(value: unknown): boolean {
  const row = socialObject(value);
  return Boolean(row && socialText(row.zh) && socialText(row.en));
}

/**
 * Draft persistence is deliberately permissive so an administrator can save
 * work in progress. No draft default is treated as authored direction. This
 * gate is the single server-side boundary for trial, gray and active usage.
 */
function assertFormulaReleaseReady(formula: InternalSocialContentFormula): void {
  const direction = formula.direction;
  const music = direction?.music;
  const voiceover = direction?.voiceover;
  const subtitles = direction?.subtitles;
  const cover = direction?.cover;
  const fallback = direction?.materialFallback;
  const risks = direction?.risks;
  const gates = direction?.acceptanceGates;
  const incompleteDirection = !direction
    || !direction.pace
    || !socialText(direction.visualStyle)
    || !music
    || !socialText(music.mood)
    || !Number.isFinite(music.volume)
    || !socialText(music.strategy)
    || !music.sourceType
    || typeof music.licenseVerified !== 'boolean'
    || (music.sourceType !== 'none' && (!music.licenseVerified || !socialText(music.licenseReference)))
    || !voiceover
    || !socialText(voiceover.voice)
    || !voiceover.preset
    || !Number.isFinite(voiceover.speed)
    || !voiceover.pauseStyle
    || !subtitles
    || !Number.isFinite(subtitles.fontScale)
    || !Number.isFinite(subtitles.bottomRatio)
    || !socialText(subtitles.styleIntent)
    || !cover
    || !socialText(cover.intent)
    || !completeLocalizedTemplate(cover.headlineTemplate)
    || !socialText(cover.subject)
    || !socialText(cover.composition)
    || !fallback
    || !Number.isSafeInteger(fallback.minimumUsableClips)
    || Number(fallback.minimumUsableClips) < 1
    || typeof fallback.allowStillFrames !== 'boolean'
    || typeof fallback.allowRepeatedClips !== 'boolean'
    || !Number.isSafeInteger(fallback.maxRepeatCount)
    || !fallback.insufficientMaterialAction
    || !risks
    || !Array.isArray(risks.prohibitedClaims)
    || !Array.isArray(risks.prohibitedVisuals)
    || !Array.isArray(risks.mandatoryDisclosures)
    || !Array.isArray(gates)
    || gates.length < 1
    || !gates.some(gate => gate.blocking === true);
  const nodesIncomplete = formula.nodes.length < 1 || formula.nodes.some(node => !socialText(node.shotFunction)
    || !socialText(node.subject)
    || !socialText(node.action)
    || !socialText(node.environment)
    || !node.orientation
    || !node.shotType
    || !node.shotSize
    || !node.cameraMovement
    || !socialText(node.composition)
    || !node.transition
    || !node.durationSeconds
    || !Number.isFinite(node.durationSeconds.minimum)
    || node.durationSeconds.minimum <= 0
    || !Number.isFinite(node.durationSeconds.maximum)
    || node.durationSeconds.maximum < node.durationSeconds.minimum
    || typeof node.required !== 'boolean'
    || !completeLocalizedTemplate(node.scriptTemplate)
    || !completeLocalizedTemplate(node.voiceoverTemplate)
    || !completeLocalizedTemplate(node.captionTemplate));
  if (incompleteDirection || nodesIncomplete) {
    throw new SocialContentWorkflowError('social_content_formula_release_incomplete', 422);
  }
}

export async function listSocialContentFormulas(input: {
  repository: Starter198Repository;
  tenantId: string;
}): Promise<InternalSocialContentFormula[]> {
  const stored = (await formulaRows(input.repository, input.tenantId))
    .map(parseStoredFormula).filter((item): item is InternalSocialContentFormula => Boolean(item));
  return [...stored, ...INTERNAL_SOCIAL_CONTENT_FORMULAS.map(item => ({ ...item }))];
}

async function findStoredFormula(input: {
  repository: Starter198Repository;
  tenantId: string;
  formulaId: string;
  version: string;
}): Promise<{ row: StarterRecord; formula: InternalSocialContentFormula }> {
  const matches = (await formulaRows(input.repository, input.tenantId)).map(row => ({ row, formula: parseStoredFormula(row) }))
    .filter(item => item.formula?.formulaId === input.formulaId && item.formula.version === input.version);
  if (matches.length > 1) throw new SocialContentWorkflowError('social_content_formula_integrity_violation', 503);
  const match = matches[0];
  if (!match?.formula) throw new SocialContentWorkflowError('social_content_formula_not_found', 404);
  return { row: match.row, formula: match.formula };
}

function storedPlan(formula: InternalSocialContentFormula, idempotencyKey: string) {
  return {
    schemaVersion: FORMULA_SCHEMA,
    lastIdempotencyKey: idempotencyKey,
    formula: {
      formulaId: formula.formulaId,
      version: formula.version,
      name: formula.name,
      themeId: formula.themeId,
      rollout: formula.rollout,
      ...(formula.direction ? { direction: formula.direction } : {}),
      nodes: formula.nodes,
      audit: formula.audit,
    },
  };
}

async function ensureUnique(input: {
  repository: Starter198Repository;
  tenantId: string;
  formulaId: string;
  version: string;
}): Promise<void> {
  const formulas = await listSocialContentFormulas(input);
  if (formulas.some(item => item.formulaId === input.formulaId && item.version === input.version)) {
    throw new SocialContentWorkflowError('social_content_formula_version_exists', 409);
  }
}

export async function createSocialContentFormula(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  idempotencyKey: string;
  value: unknown;
  now?: Date;
}): Promise<InternalSocialContentFormula> {
  const body = socialObject(input.value);
  if (!body || Object.keys(body).some(key => !['formulaId', 'version', 'name', 'themeId', 'rollout', 'direction', 'nodes', 'note'].includes(key))) {
    throw new SocialContentWorkflowError('social_content_formula_input_invalid', 400);
  }
  const rows = await formulaRows(input.repository, input.tenantId);
  const replay = rows.find(row => socialText(socialObject(socialJson(row.plan))?.lastIdempotencyKey) === input.idempotencyKey);
  if (replay) return parseStoredFormula(replay)!;
  const themeId = socialText(body.themeId) as SocialContentThemeId;
  if (!SOCIAL_CONTENT_THEME_IDS.includes(themeId)) throw new SocialContentWorkflowError('social_content_theme_invalid', 400);
  const formula: InternalSocialContentFormula = {
    formulaId: formulaKey(body.formulaId, 'social_content_formula_id_invalid'),
    version: semanticVersion(body.version),
    name: requiredText(body.name, 'social_content_formula_name_invalid', 160),
    themeId,
    status: 'draft',
    rollout: parseRollout(body.rollout),
    direction: parseDirection(body.direction),
    nodes: parseNodes(body.nodes),
    audit: [{
      event: 'draft_created', actor: input.userId, at: (input.now ?? new Date()).toISOString(),
      ...(socialText(body.note) ? { note: socialText(body.note) } : {}),
    }],
  };
  await ensureUnique({ ...input, formulaId: formula.formulaId, version: formula.version });
  const created = await input.repository.create(STARTER_COLLECTIONS.plans, input.tenantId, {
    id: socialPublicId('socialformula'),
    goal_id: `social-content-formula:${formula.formulaId}`,
    status: formula.status,
    plan: storedPlan(formula, input.idempotencyKey),
    created_at: (input.now ?? new Date()).toISOString(),
    updated_at: (input.now ?? new Date()).toISOString(),
  });
  return parseStoredFormula(created)!;
}

export async function createSocialContentFormulaVersion(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  formulaId: string;
  sourceVersion: string;
  idempotencyKey: string;
  value: unknown;
  now?: Date;
}): Promise<InternalSocialContentFormula> {
  const body = socialObject(input.value);
  if (!body || Object.keys(body).some(key => !['version', 'name', 'rollout', 'direction', 'nodes', 'note'].includes(key))) {
    throw new SocialContentWorkflowError('social_content_formula_input_invalid', 400);
  }
  const rows = await formulaRows(input.repository, input.tenantId);
  const replay = rows.find(row => socialText(socialObject(socialJson(row.plan))?.lastIdempotencyKey) === input.idempotencyKey);
  if (replay) return parseStoredFormula(replay)!;
  const { formula: source } = await findStoredFormula({
    repository: input.repository,
    tenantId: input.tenantId,
    formulaId: input.formulaId,
    version: input.sourceVersion,
  });
  const formula: InternalSocialContentFormula = {
    ...source,
    recordId: undefined,
    version: semanticVersion(body.version),
    name: body.name === undefined ? source.name : requiredText(body.name, 'social_content_formula_name_invalid', 160),
    rollout: parseRollout(body.rollout, source.rollout),
    direction: body.direction === undefined ? source.direction : parseDirection(body.direction),
    nodes: body.nodes === undefined ? source.nodes : parseNodes(body.nodes),
    status: 'draft',
    audit: [...source.audit, {
      event: 'version_created', actor: input.userId, at: (input.now ?? new Date()).toISOString(),
      note: socialText(body.note) || `forked_from:${source.version}`,
    }],
  };
  await ensureUnique({ ...input, formulaId: formula.formulaId, version: formula.version });
  const created = await input.repository.create(STARTER_COLLECTIONS.plans, input.tenantId, {
    id: socialPublicId('socialformula'),
    goal_id: `social-content-formula:${formula.formulaId}`,
    status: formula.status,
    plan: storedPlan(formula, input.idempotencyKey),
    created_at: (input.now ?? new Date()).toISOString(),
    updated_at: (input.now ?? new Date()).toISOString(),
  });
  return parseStoredFormula(created)!;
}

async function transitionFormula(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  formulaId: string;
  version: string;
  idempotencyKey: string;
  event: 'trial_started' | 'published_gray' | 'published_active' | 'disabled';
  status: FormulaStatus;
  rollout?: InternalSocialContentFormula['rollout'];
  note?: string;
  now?: Date;
}): Promise<InternalSocialContentFormula> {
  const { row, formula } = await findStoredFormula(input);
  const oldPlan = socialObject(socialJson(row.plan));
  if (socialText(oldPlan?.lastIdempotencyKey) === input.idempotencyKey) return formula;
  if (input.status !== 'disabled') assertFormulaReleaseReady(formula);
  if (formula.status === 'disabled' && input.status !== 'disabled') {
    throw new SocialContentWorkflowError('social_content_formula_transition_invalid', 409);
  }
  if (input.event === 'trial_started' && !['draft', 'internal_trial'].includes(formula.status)) {
    throw new SocialContentWorkflowError('social_content_formula_transition_invalid', 409);
  }
  if (input.event === 'published_gray' && !['internal_trial', 'gray'].includes(formula.status)) {
    throw new SocialContentWorkflowError('social_content_formula_transition_invalid', 409);
  }
  if (input.event === 'published_active' && !['internal_trial', 'gray', 'active'].includes(formula.status)) {
    throw new SocialContentWorkflowError('social_content_formula_transition_invalid', 409);
  }
  const next: InternalSocialContentFormula = {
    ...formula,
    status: input.status,
    rollout: input.rollout ?? formula.rollout,
    audit: [...formula.audit, {
      event: input.event, actor: input.userId, at: (input.now ?? new Date()).toISOString(),
      ...(input.note ? { note: input.note } : {}),
    }],
  };
  await input.repository.update(STARTER_COLLECTIONS.plans, input.tenantId, row.id, {
    status: next.status,
    plan: storedPlan(next, input.idempotencyKey),
    updated_at: (input.now ?? new Date()).toISOString(),
  });
  return (await findStoredFormula(input)).formula;
}

export async function trialSocialContentFormula(input: Omit<Parameters<typeof transitionFormula>[0], 'event' | 'status' | 'rollout'>) {
  const formula = await transitionFormula({ ...input, event: 'trial_started', status: 'internal_trial' });
  return { formula, preview: initialMaterialRequirements(formula.themeId, (input.now ?? new Date()).toISOString(), formula).requirements };
}

export async function publishSocialContentFormula(input: {
  repository: Starter198Repository;
  tenantId: string;
  userId: string;
  formulaId: string;
  version: string;
  idempotencyKey: string;
  value: unknown;
  now?: Date;
}): Promise<InternalSocialContentFormula> {
  const body = socialObject(input.value);
  if (!body || Object.keys(body).some(key => !['status', 'rollout', 'note'].includes(key))) {
    throw new SocialContentWorkflowError('social_content_formula_publish_invalid', 400);
  }
  const status = socialText(body.status);
  if (!['gray', 'active'].includes(status)) throw new SocialContentWorkflowError('social_content_formula_publish_invalid', 400);
  const rollout = status === 'active'
    ? { percentage: 100, tenantAllowlist: [] }
    : parseRollout(body.rollout);
  if (status === 'gray' && rollout.percentage === 0 && rollout.tenantAllowlist.length === 0) {
    throw new SocialContentWorkflowError('social_content_formula_rollout_invalid', 400);
  }
  return transitionFormula({
    ...input,
    event: status === 'gray' ? 'published_gray' : 'published_active',
    status: status as FormulaStatus,
    rollout,
    note: socialText(body.note) || undefined,
  });
}

export async function disableSocialContentFormula(input: Omit<Parameters<typeof transitionFormula>[0], 'event' | 'status' | 'rollout'>) {
  return transitionFormula({ ...input, event: 'disabled', status: 'disabled' });
}

function rolloutIncludes(formula: InternalSocialContentFormula, tenantId: string): boolean {
  if (formula.status === 'active') return true;
  if (formula.status !== 'gray') return false;
  // Current PRD authorizes gray releases by an explicit tenant allowlist only.
  // Keep percentage as forward-compatible metadata, but never use it as an
  // authorization signal until a later contract explicitly enables sampling.
  return formula.rollout.tenantAllowlist.length > 0
    && formula.rollout.tenantAllowlist.includes(tenantId);
}

export async function resolveSocialContentFormula(input: {
  repository: Starter198Repository;
  tenantId: string;
  themeId: SocialContentThemeId;
}): Promise<InternalSocialContentFormula> {
  const formulas = await listSocialContentFormulas({
    repository: input.repository,
    tenantId: SOCIAL_FORMULA_CATALOG_TENANT,
  });
  const eligible = formulas.filter(formula => formula.themeId === input.themeId
    && rolloutIncludes(formula, input.tenantId));
  eligible.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const selected = eligible[0];
  if (!selected) throw new SocialContentWorkflowError('social_content_formula_unavailable', 503);
  assertFormulaReleaseReady(selected);
  return selected;
}

/** Resolve the exact version already frozen onto a task, even if a newer formula is active. */
export async function resolveSocialContentFormulaReference(input: {
  repository: Starter198Repository;
  formulaId: string;
  version: string;
}): Promise<InternalSocialContentFormula> {
  const formulas = await listSocialContentFormulas({
    repository: input.repository,
    tenantId: SOCIAL_FORMULA_CATALOG_TENANT,
  });
  const matches = formulas.filter(formula => formula.formulaId === input.formulaId && formula.version === input.version);
  if (matches.length !== 1) throw new SocialContentWorkflowError('social_content_formula_reference_invalid', 503);
  const selected = matches[0]!;
  assertFormulaReleaseReady(selected);
  return selected;
}
