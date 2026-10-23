import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

/**
 * Storyboard contract and validation for the interview exercise.
 *
 * The validator is deliberately strict about the things the final delivery
 * depends on: a continuous 30–37s timeline, at least two presenter shots and
 * two illustration shots, real public-catalog identifiers, and a licensed
 * source for every illustration. It never relaxes those checks for the UI.
 */

export const STORYBOARD_SCHEMA_VERSION = 1 as const;
export const STORYBOARD_ASSET_PATH = 'assets/storyboard.json';
export const REFERENCE_FILE = 'assets/reference-analysis-only.mp4';
export const STORYBOARD_MIN_SECONDS = 30;
export const STORYBOARD_MAX_SECONDS = 37;
export const STORYBOARD_MIN_SHOTS = 4;
export const STORYBOARD_MAX_SHOTS = 20;
export const STORYBOARD_MAX_BYTES = 256 * 1024;

const SHOT_ID = /^[a-z][a-z0-9_-]{1,39}$/;
const CATALOG_ID = /^[A-Za-z0-9_-]{8,128}$/;
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const LOCAL_FILE = /^assets\/[A-Za-z0-9._/-]+$/;
const PLACEHOLDER_START = /^(?:select_from|to_be_|replace_|todo|tbd|placeholder)/i;
const PLACEHOLDER_ANYWHERE = /(?:select_from_live_catalog|to_be_provided|to_be_verified|replace_with)/i;

export type ShotKind = 'presenter' | 'illustration';

export interface StoryboardSource {
  localFile?: string;
  sourceUrl?: string;
  license: string;
  author?: string;
  notes?: string;
}

export interface StoryboardShot {
  id: string;
  kind: ShotKind;
  startSeconds: number;
  durationSeconds: number;
  speech: string;
  subtitle: string;
  framing: string;
  source: StoryboardSource | null;
}

export interface StoryboardCatalogEvidence {
  probeFile?: string;
  probeVideoId?: string;
  checkedAt?: string;
  note?: string;
}

export interface StoryboardPresenter {
  provider: 'heygen';
  ownership: 'public';
  avatarId: string;
  voiceId: string;
  catalogEvidence?: StoryboardCatalogEvidence;
}

export interface Storyboard {
  schemaVersion: 1;
  referenceFile: string;
  referenceSha256?: string;
  targetDurationSeconds: number;
  language: string;
  presenter: StoryboardPresenter;
  shots: StoryboardShot[];
}

export interface StoryboardIssue {
  path: string;
  code: string;
  message: string;
}

export type StoryboardValidation =
  | {ok: true; value: Storyboard; issues: []}
  | {ok: false; issues: StoryboardIssue[]};

export interface StoryboardValidationOptions {
  checkLocalFiles?: boolean;
  projectRoot?: string;
}

export interface SavedStoryboard {
  path: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
  savedAt: string;
}

export interface StoryboardReadResult {
  ok: boolean;
  path: string;
  exists: boolean;
  raw: string | null;
  storyboard: Storyboard | null;
  issues: StoryboardIssue[];
  sha256: string | null;
  savedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlaceholder(value: string): boolean {
  const text = value.trim();
  return PLACEHOLDER_START.test(text) || PLACEHOLDER_ANYWHERE.test(text);
}

function addIssue(issues: StoryboardIssue[], at: string, code: string, message: string): void {
  if (issues.length >= 200) return;
  issues.push({path: at, code, message});
}

function readString(
  value: unknown,
  at: string,
  issues: StoryboardIssue[],
  options: {min?: number; max?: number; required?: boolean; placeholder?: boolean} = {},
): string | null {
  const required = options.required ?? true;
  const min = options.min ?? 1;
  const max = options.max ?? 500;
  if (value === undefined || value === null) {
    if (required) addIssue(issues, at, 'required', '缺少必填字段');
    return null;
  }
  if (typeof value !== 'string') {
    addIssue(issues, at, 'string_required', '必须是字符串');
    return null;
  }
  const text = value.trim();
  if (text.length < min) {
    addIssue(issues, at, 'too_short', `至少需要 ${min} 个字符`);
    return null;
  }
  if (text.length > max) {
    addIssue(issues, at, 'too_long', `最多允许 ${max} 个字符`);
    return null;
  }
  if (options.placeholder && isPlaceholder(text)) {
    addIssue(issues, at, 'placeholder_value', '不能使用占位值，请替换为真实内容');
    return null;
  }
  return text;
}

function readNumber(
  value: unknown,
  at: string,
  issues: StoryboardIssue[],
  options: {min: number; max: number},
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    addIssue(issues, at, 'number_required', '必须是有限数字');
    return null;
  }
  if (value < options.min || value > options.max) {
    addIssue(issues, at, 'number_out_of_range', `必须在 ${options.min}–${options.max} 之间`);
    return null;
  }
  return Math.round(value * 1000) / 1000;
}

function readOptionalString(
  value: unknown,
  at: string,
  issues: StoryboardIssue[],
  max: number,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  return readString(value, at, issues, {required: false, min: 1, max});
}

function safeResolvedPath(root: string, relative: string): string | null {
  const absolute = path.resolve(root, relative);
  const assets = path.resolve(root, 'assets');
  if (absolute !== assets && !absolute.startsWith(assets + path.sep)) return null;
  return absolute;
}

function validateSource(
  value: unknown,
  at: string,
  issues: StoryboardIssue[],
  options: Required<Pick<StoryboardValidationOptions, 'checkLocalFiles' | 'projectRoot'>>,
): StoryboardSource | null {
  const before = issues.length;
  if (!isRecord(value)) {
    addIssue(issues, at, 'source_object_required', '说明镜头必须提供素材来源对象');
    return null;
  }
  const license = readString(value.license, `${at}.license`, issues, {min: 3, max: 240, placeholder: true});
  const localFile = readOptionalString(value.localFile, `${at}.localFile`, issues, 300);
  const sourceUrl = readOptionalString(value.sourceUrl, `${at}.sourceUrl`, issues, 500);
  const author = readOptionalString(value.author, `${at}.author`, issues, 160);
  const notes = readOptionalString(value.notes, `${at}.notes`, issues, 500);

  if (!localFile && !sourceUrl) {
    addIssue(issues, at, 'source_location_required', '必须提供 localFile 或 sourceUrl');
  }

  if (localFile) {
    const normalized = localFile.replaceAll('\\', '/');
    if (normalized !== localFile) addIssue(issues, `${at}.localFile`, 'forward_slashes_required', '本地路径必须使用正斜杠');
    if (!LOCAL_FILE.test(localFile) || localFile.split('/').some(segment => segment === '..' || segment === '.')) {
      addIssue(issues, `${at}.localFile`, 'local_file_outside_assets', '本地素材必须位于 assets/ 下且不能包含 . 或 ..');
    }
    if (/reference-analysis-only/i.test(localFile)) {
      addIssue(issues, `${at}.localFile`, 'reference_pixels_forbidden', '不得把参考片本身作为说明素材');
      addIssue(issues, `${at}.localFile`, 'reference_used_as_source', '参考片不能作为成片素材');
    }
    if (options.checkLocalFiles) {
      const absolute = safeResolvedPath(options.projectRoot, localFile);
      try {
        if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size <= 0) {
          addIssue(issues, `${at}.localFile`, 'source_file_missing', `素材文件不存在或为空：${localFile}`);
        }
      } catch {
        addIssue(issues, `${at}.localFile`, 'source_file_unreadable', `素材文件无法读取：${localFile}`);
      }
    }
  }

  if (sourceUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      addIssue(issues, `${at}.sourceUrl`, 'invalid_url', 'sourceUrl 不是合法 URL');
    }
    if (parsed) {
      if (!['http:', 'https:'].includes(parsed.protocol)) addIssue(issues, `${at}.sourceUrl`, 'url_scheme_unsupported', '只接受 http/https 素材地址');
      if (parsed.username || parsed.password) addIssue(issues, `${at}.sourceUrl`, 'url_credentials_forbidden', '素材地址不能包含凭据');
      if (/yuchengcosmeticsfactory|reference-analysis-only/i.test(sourceUrl)) {
        addIssue(issues, `${at}.sourceUrl`, 'reference_source_forbidden', '不得引用参考片或其原始作者素材');
      }
    }
  }

  if (issues.length !== before) return null;
  const result: StoryboardSource = {license: license as string};
  if (localFile) result.localFile = localFile;
  if (sourceUrl) result.sourceUrl = sourceUrl;
  if (author) result.author = author;
  if (notes) result.notes = notes;
  return result;
}

/**
 * Reject tenant identity anywhere in the payload. The local server derives
 * tenant scope from its own context; a client-supplied tenant is never an
 * authorization signal.
 */
export function findClientTenantFields(input: unknown, at = '$', found: StoryboardIssue[] = []): StoryboardIssue[] {
  if (found.length >= 20) return found;
  if (Array.isArray(input)) {
    input.forEach((item, index) => findClientTenantFields(item, `${at}[${index}]`, found));
    return found;
  }
  if (!isRecord(input)) return found;
  for (const [key, value] of Object.entries(input)) {
    const field = `${at}.${key}`;
    if (key === 'tenantId' || key === 'tenant_id') {
      addIssue(found, field, 'client_tenant_not_accepted', '不接受客户端传入 tenantId 作为授权；租户由服务端上下文决定');
      continue;
    }
    findClientTenantFields(value, field, found);
  }
  return found;
}

export function parseStoryboardText(text: string): {ok: true; value: unknown} | {ok: false; issues: StoryboardIssue[]} {
  try {
    return {ok: true, value: JSON.parse(text) as unknown};
  } catch (error) {
    return {
      ok: false,
      issues: [{
        path: '$',
        code: 'invalid_json',
        message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
}

export function validateStoryboard(
  input: unknown,
  options: StoryboardValidationOptions = {},
): StoryboardValidation {
  const issues: StoryboardIssue[] = [];
  const config = {
    checkLocalFiles: options.checkLocalFiles ?? true,
    projectRoot: path.resolve(options.projectRoot ?? process.cwd()),
  };

  if (!isRecord(input)) {
    addIssue(issues, '$', 'root_object_required', '分镜根节点必须是 JSON 对象');
    return {ok: false, issues};
  }

  if (input.schemaVersion !== STORYBOARD_SCHEMA_VERSION) {
    addIssue(issues, '$.schemaVersion', 'schema_version_unsupported', `schemaVersion 必须为 ${STORYBOARD_SCHEMA_VERSION}`);
  }

  const referenceFile = readString(input.referenceFile, '$.referenceFile', issues, {min: 5, max: 300, placeholder: true});
  if (referenceFile) {
    if (!LOCAL_FILE.test(referenceFile) || referenceFile.split('/').some(segment => segment === '..' || segment === '.')) {
      addIssue(issues, '$.referenceFile', 'reference_path_invalid', 'referenceFile 必须是 assets/ 下的相对路径');
    } else if (config.checkLocalFiles) {
      const absolute = safeResolvedPath(config.projectRoot, referenceFile);
      try {
        if (!absolute || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size <= 0) {
          addIssue(issues, '$.referenceFile', 'reference_file_missing', `参考片不存在或为空：${referenceFile}`);
        }
      } catch {
        addIssue(issues, '$.referenceFile', 'reference_file_unreadable', `参考片无法读取：${referenceFile}`);
      }
    }
  }

  const referenceSha256 = readOptionalString(input.referenceSha256, '$.referenceSha256', issues, 64);
  if (referenceSha256 && !/^[a-f0-9]{64}$/i.test(referenceSha256)) {
    addIssue(issues, '$.referenceSha256', 'sha256_invalid', 'referenceSha256 必须是 64 位十六进制');
  }

  const targetDuration = readNumber(input.targetDurationSeconds, '$.targetDurationSeconds', issues, {
    min: STORYBOARD_MIN_SECONDS,
    max: STORYBOARD_MAX_SECONDS,
  });

  const language = readString(input.language, '$.language', issues, {min: 2, max: 20});
  if (language && !LANGUAGE.test(language)) {
    addIssue(issues, '$.language', 'language_invalid', 'language 必须是 BCP-47 形式的语言标签，例如 en 或 zh-CN');
  }

  let presenter: StoryboardPresenter | null = null;
  if (!isRecord(input.presenter)) {
    addIssue(issues, '$.presenter', 'presenter_required', 'presenter 必须是对象');
  } else {
    const presenterBefore = issues.length;
    const provider = readString(input.presenter.provider, '$.presenter.provider', issues, {min: 5, max: 20});
    if (provider && provider !== 'heygen') addIssue(issues, '$.presenter.provider', 'provider_unsupported', '本题只接受 heygen 公共数字人');
    const ownership = readString(input.presenter.ownership, '$.presenter.ownership', issues, {min: 1, max: 20});
    if (ownership && ownership !== 'public') {
      addIssue(issues, '$.presenter.ownership', 'public_ownership_required', '本题只接受 ownership=public；不得伪造克隆授权');
    }
    const avatarId = readString(input.presenter.avatarId, '$.presenter.avatarId', issues, {min: 8, max: 128, placeholder: true});
    const voiceId = readString(input.presenter.voiceId, '$.presenter.voiceId', issues, {min: 8, max: 128, placeholder: true});
    if (avatarId && !CATALOG_ID.test(avatarId)) addIssue(issues, '$.presenter.avatarId', 'catalog_id_invalid', 'avatarId 格式不合法');
    if (voiceId && !CATALOG_ID.test(voiceId)) addIssue(issues, '$.presenter.voiceId', 'catalog_id_invalid', 'voiceId 格式不合法');

    let catalogEvidence: StoryboardCatalogEvidence | undefined;
    if (input.presenter.catalogEvidence !== undefined && input.presenter.catalogEvidence !== null) {
      if (!isRecord(input.presenter.catalogEvidence)) {
        addIssue(issues, '$.presenter.catalogEvidence', 'catalog_evidence_object_required', 'catalogEvidence 必须是对象');
      } else {
        catalogEvidence = {};
        const probeFile = readOptionalString(input.presenter.catalogEvidence.probeFile, '$.presenter.catalogEvidence.probeFile', issues, 300);
        const probeVideoId = readOptionalString(input.presenter.catalogEvidence.probeVideoId, '$.presenter.catalogEvidence.probeVideoId', issues, 200);
        const checkedAt = readOptionalString(input.presenter.catalogEvidence.checkedAt, '$.presenter.catalogEvidence.checkedAt', issues, 40);
        const note = readOptionalString(input.presenter.catalogEvidence.note, '$.presenter.catalogEvidence.note', issues, 500);
        if (probeFile) catalogEvidence.probeFile = probeFile;
        if (probeVideoId) catalogEvidence.probeVideoId = probeVideoId;
        if (checkedAt) catalogEvidence.checkedAt = checkedAt;
        if (note) catalogEvidence.note = note;
      }
    }

    if (issues.length === presenterBefore && provider && ownership && avatarId && voiceId) {
      presenter = {provider: 'heygen', ownership: 'public', avatarId, voiceId};
      if (catalogEvidence) presenter.catalogEvidence = catalogEvidence;
    }
  }

  const shots: StoryboardShot[] = [];
  const shotIds = new Set<string>();
  const timings: Array<{index: number; start: number; duration: number; at: string}> = [];
  let presenterCount = 0;
  let illustrationCount = 0;

  if (!Array.isArray(input.shots)) {
    addIssue(issues, '$.shots', 'shots_required', 'shots 必须是数组');
  } else {
    if (input.shots.length < STORYBOARD_MIN_SHOTS) {
      addIssue(issues, '$.shots', 'shots_minimum', `至少需要 ${STORYBOARD_MIN_SHOTS} 个镜头`);
    }
    if (input.shots.length > STORYBOARD_MAX_SHOTS) {
      addIssue(issues, '$.shots', 'shots_maximum', `最多允许 ${STORYBOARD_MAX_SHOTS} 个镜头`);
    }

    input.shots.forEach((rawShot, index) => {
      const at = `$.shots[${index}]`;
      if (!isRecord(rawShot)) {
        addIssue(issues, at, 'shot_object_required', '镜头必须是对象');
        return;
      }
      const before = issues.length;
      const id = readString(rawShot.id, `${at}.id`, issues, {min: 2, max: 40});
      if (id) {
        if (!SHOT_ID.test(id)) addIssue(issues, `${at}.id`, 'shot_id_invalid', 'id 必须是小写字母开头，仅含小写字母、数字、_、-');
        if (shotIds.has(id)) addIssue(issues, `${at}.id`, 'duplicate_shot_id', `镜头 id 重复：${id}`);
        shotIds.add(id);
      }
      const kind = readString(rawShot.kind, `${at}.kind`, issues, {min: 9, max: 12});
      if (kind && kind !== 'presenter' && kind !== 'illustration') {
        addIssue(issues, `${at}.kind`, 'shot_kind_invalid', 'kind 只能是 presenter 或 illustration');
      }
      if (kind === 'presenter') presenterCount += 1;
      if (kind === 'illustration') illustrationCount += 1;

      const start = readNumber(rawShot.startSeconds, `${at}.startSeconds`, issues, {min: 0, max: STORYBOARD_MAX_SECONDS});
      const duration = readNumber(rawShot.durationSeconds, `${at}.durationSeconds`, issues, {min: 0.25, max: STORYBOARD_MAX_SECONDS});
      const speech = readString(rawShot.speech, `${at}.speech`, issues, {min: 1, max: 600});
      const subtitle = readString(rawShot.subtitle, `${at}.subtitle`, issues, {min: 1, max: 140});
      const framing = readString(rawShot.framing, `${at}.framing`, issues, {min: 1, max: 200});

      let source: StoryboardSource | null = null;
      if (kind === 'presenter') {
        if (rawShot.source !== undefined && rawShot.source !== null) {
          addIssue(issues, `${at}.source`, 'presenter_source_must_be_null', '人物镜头不需要素材来源，source 必须为 null');
        }
      } else if (kind === 'illustration') {
        if (rawShot.source === undefined || rawShot.source === null) {
          addIssue(issues, `${at}.source`, 'illustration_source_required', '说明镜头必须提供素材来源');
        } else {
          source = validateSource(rawShot.source, `${at}.source`, issues, config);
        }
      }

      if (start !== null && duration !== null) timings.push({index, start, duration, at});
      if (issues.length === before && id && kind && start !== null && duration !== null && speech && subtitle && framing
        && (kind === 'presenter' || source)) {
        shots.push({
          id,
          kind: kind as ShotKind,
          startSeconds: start,
          durationSeconds: duration,
          speech,
          subtitle,
          framing,
          source: kind === 'presenter' ? null : source,
        });
      }
    });
  }

  if (presenterCount < 2) addIssue(issues, '$.shots', 'presenter_shot_minimum', '至少需要 2 个人物口播镜头');
  if (illustrationCount < 2) addIssue(issues, '$.shots', 'illustration_shot_minimum', '至少需要 2 个说明性镜头');

  if (timings.length === (Array.isArray(input.shots) ? input.shots.length : 0) && timings.length > 0) {
    if (Math.abs(timings[0].start) > 0.001) {
      addIssue(issues, timings[0].at + '.startSeconds', 'timeline_start', '第一个镜头必须从 0 秒开始');
    }
    for (let index = 1; index < timings.length; index += 1) {
      const previous = timings[index - 1];
      const current = timings[index];
      const expected = previous.start + previous.duration;
      if (current.start > expected + 0.002) {
        addIssue(issues, current.at + '.startSeconds', 'timeline_gap', `时间轴出现空洞：上一镜结束于 ${expected.toFixed(3)}s，当前从 ${current.start.toFixed(3)}s 开始`);
      } else if (current.start < expected - 0.002) {
        addIssue(issues, current.at + '.startSeconds', 'timeline_overlap', `时间轴发生重叠：上一镜结束于 ${expected.toFixed(3)}s，当前从 ${current.start.toFixed(3)}s 开始`);
      }
    }
    const last = timings[timings.length - 1];
    const total = last.start + last.duration;
    if (targetDuration !== null && Math.abs(total - targetDuration) > 0.05) {
      addIssue(issues, '$.targetDurationSeconds', 'timeline_duration_mismatch', `镜头总时长 ${total.toFixed(3)}s 与 targetDurationSeconds ${targetDuration.toFixed(3)}s 不一致`);
    }
  }

  if (referenceFile && shots.some(shot => shot.source?.localFile === referenceFile)) {
    addIssue(issues, '$.shots', 'reference_used_as_source', '参考片不能作为成片素材');
  }

  if (issues.length > 0 || !presenter || !referenceFile || targetDuration === null || !language) {
    return {ok: false, issues: issues.length ? issues : [{path: '$', code: 'storyboard_incomplete', message: '分镜字段不完整'}]};
  }

  const value: Storyboard = {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    referenceFile,
    ...(referenceSha256 ? {referenceSha256} : {}),
    targetDurationSeconds: targetDuration,
    language,
    presenter,
    shots,
  };
  return {ok: true, value, issues: []};
}

export async function readStoryboardFile(
  filePath = STORYBOARD_ASSET_PATH,
  options: StoryboardValidationOptions & {requireExists?: boolean} = {},
): Promise<StoryboardReadResult> {
  const absolute = path.resolve(options.projectRoot ?? process.cwd(), filePath);
  const base = {path: filePath, exists: false, raw: null, storyboard: null, issues: [], sha256: null, savedAt: null};
  try {
    const [bytes, stat] = await Promise.all([fsp.readFile(absolute), fsp.stat(absolute)]);
    const raw = bytes.toString('utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const parsed = parseStoryboardText(raw);
    if (!parsed.ok) {
      return {...base, ok: false, exists: true, raw, issues: parsed.issues, sha256, savedAt: stat.mtime.toISOString()};
    }
    const validated = validateStoryboard(parsed.value, options);
    return {
      ...base,
      ok: validated.ok,
      exists: true,
      raw,
      storyboard: validated.ok ? validated.value : null,
      issues: validated.ok ? [] : validated.issues,
      sha256,
      savedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const issues: StoryboardIssue[] = options.requireExists
        ? [{path: '$', code: 'file_not_found', message: `分镜文件不存在：${filePath}`}]
        : [];
      return {...base, ok: !options.requireExists, issues};
    }
    return {
      ...base,
      ok: false,
      issues: [{path: '$', code: 'file_unreadable', message: error instanceof Error ? error.message : String(error)}],
    };
  }
}

export async function saveStoryboardFile(
  storyboard: Storyboard,
  filePath = STORYBOARD_ASSET_PATH,
  options: StoryboardValidationOptions = {},
): Promise<SavedStoryboard> {
  const validated = validateStoryboard(storyboard, options);
  if (!validated.ok) {
    const detail = validated.issues.map(item => `${item.path} ${item.code}`).join('; ');
    throw new Error(`cannot_save_invalid_storyboard: ${detail}`);
  }
  const absolute = path.resolve(options.projectRoot ?? process.cwd(), filePath);
  await fsp.mkdir(path.dirname(absolute), {recursive: true});
  const text = `${JSON.stringify(validated.value, null, 2)}\n`;
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temporary, text, {encoding: 'utf8', mode: 0o644});
  try {
    await fsp.rename(temporary, absolute);
  } catch (error) {
    await fsp.rm(temporary, {force: true});
    throw error;
  }
  const bytes = await fsp.readFile(absolute);
  return {
    path: filePath,
    absolutePath: absolute,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    savedAt: new Date().toISOString(),
  };
}

/** Compact summary used by the CLI, page and review notes. */
export function storyboardSummary(storyboard: Storyboard): {
  shots: number;
  presenterShots: number;
  illustrationShots: number;
  totalSeconds: number;
} {
  return {
    shots: storyboard.shots.length,
    presenterShots: storyboard.shots.filter(shot => shot.kind === 'presenter').length,
    illustrationShots: storyboard.shots.filter(shot => shot.kind === 'illustration').length,
    totalSeconds: Math.round(storyboard.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) * 1000) / 1000,
  };
}
