import { Router } from 'express';
import { randomUUID } from 'crypto';
import { enterpriseProductIdentity, mergeEnterpriseProductIdentity } from '../lib/enterpriseProductIdentity.js';
import type { Request } from 'express';
import { store } from '../storage/index.js';
import { callLLM } from '../agents/llm.js';
import { notifyDeliveryTeam } from '../lib/tenantPlatformApps.js';
import { requireAuth, type AuthLocals } from '../middleware/auth.js';
import {
  productApiSecretForKey,
  productApiSecretForTenant,
  type ProductApiCredential,
} from '../lib/productApiCredentials.js';
import { enterpriseProductApiRouter } from './enterpriseProductApi.js';
import { readCustomerMessagingAuthorization } from '../digitalEmployees/customerMessagingPolicy.js';
import {
  assertLegacyExternalEffectAllowed,
  Starter198LegacyEffectError,
  withLegacyExternalEffectAllowed,
} from '../starter198/legacyEffectGuard.js';
import { createEnterpriseProductFootageImportRouter } from './enterpriseProductFootageImport.js';
export { upsertLocalEnterpriseMaterial } from './enterpriseLocalMaterial.js';
import { DEFAULT_BIZ_RULES, DEFAULT_NOTIFICATIONS, readProfile, writeProfile, normalizeProfile, normalizeCustomerServiceSettings,
  normalizeAutonomy, normalizeBizRules, normalizeNotifications, mergeEnterpriseProfile,
  normalizeNotificationChannel, markProfileSaved, readTenantProfile,
  customerServicePolicyFromSettings, customerServiceStatus,
  EnterpriseFactVersionConflictError, normalizeExpectedFactVersion, writeTenantProfile, text } from './enterpriseProfileStore.js';
export { customerServicePolicyFromSettings, customerServicePolicy, customerServiceStatus, enterpriseFactContentHash, verifyEnterpriseFactContent,
  readTenantEnterpriseProfile, readTenantEnterpriseProfileStrict, updateTenantEnterpriseProfile, readEnterpriseProfile } from './enterpriseProfileStore.js';
import { registerEnterpriseOrderRoutes } from './enterpriseOrderRoutes.js';
import { registerEnterpriseAssetRoutes } from './enterpriseAssetRoutes.js';
import { buildEnterpriseContext, knowledgeCompletion, structureFaqText, inferIndustry, allPackPreviews, buildPackPreview,
  INDUSTRY_LABELS, SCENARIO_LABELS, fillPackEntry, type PackIndustry, type PackScenario } from './enterpriseKnowledge.js';
export { knowledgeCompletion, bizRulesReady, shouldSuppressPrice, autoFaqReady, findApprovedFaqAnswer, buildBizRulesInstruction,
  notificationTargetReady, buildEnterpriseContext } from './enterpriseKnowledge.js';
export type { KnowledgeSectionKey, KnowledgeCompletion } from './enterpriseKnowledge.js';
export { readOrders } from './enterpriseOrders.js';
import type { BizRules, FaqItem, NotificationReceiver, NotificationSettings, CustomerServiceStatus, EnterpriseProfile } from './enterpriseProfileContracts.js';
export type { BizRules, FaqItem, NotificationReceiver, NotificationSettings, HandoffRules, PartialAutoReplyDecision,
  CustomerServiceSettings, CustomerServicePolicy, CustomerServiceStatus, SalesStyleProfile, OrderRecord, EnterpriseProfile } from './enterpriseProfileContracts.js';

export interface ConfirmedEnterpriseFacts {
  version: NonNullable<EnterpriseProfile['factVersion']>;
  profile: EnterpriseProfile;
  context: string;
}

export async function readTenantEnterpriseFacts(tenantId: string): Promise<ConfirmedEnterpriseFacts> {
  const profile = await readTenantProfile(tenantId);
  return { version: profile.factVersion!, profile, context: buildEnterpriseContext(profile) };
}

function readApiKey(req: Request) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || bearer || '').trim();
}

async function verifyProductApiKey(req: Request): Promise<{ profile: EnterpriseProfile; secret: ProductApiCredential } | null> {
  const provided = readApiKey(req);
  if (!provided) return null;
  const secret = await productApiSecretForKey(provided);
  if (!secret) return null;
  await assertLegacyExternalEffectAllowed(secret.tenantId);
  return { profile: await readTenantProfile(secret.tenantId), secret };
}

function respondLegacyProductApiFailure(error: unknown, res: import('express').Response): void {
  if (error instanceof Starter198LegacyEffectError) {
    if (error.code === 'starter_198_orchestrator_only') {
      // This public endpoint is authenticated only by the supplied key. Do not
      // reveal that a historical starter key still exists or remains valid.
      res.status(401).json({ error: 'Invalid API Key' });
      return;
    }
    res.status(error.status).json({ error: error.code });
    return;
  }
  res.status(503).json({ error: 'product_api_unavailable' });
}

type ApiProductInput = {
  sku?: unknown;
  name?: unknown;
  color?: unknown;
  size?: unknown;
  tagPrice?: unknown;
  retailPrice?: unknown;
  moq?: unknown;
  brand?: unknown;
  material?: unknown;
  imageUrl?: unknown;
  highlights?: unknown;
  attributes?: unknown;
};

function normalizeApiProduct(input: ApiProductInput): NonNullable<EnterpriseProfile['products']['items']>[number] | null {
  const sku = text(input.sku);
  const name = text(input.name) || sku;
  if (!name) return null;
  const imageUrl = text(input.imageUrl);
  return {
    id: randomUUID(),
    sku,
    name,
    color: text(input.color),
    size: text(input.size),
    tagPrice: text(input.tagPrice),
    retailPrice: text(input.retailPrice),
    moq: text(input.moq),
    brand: text(input.brand),
    material: text(input.material),
    imageUrl,
    highlights: text(input.highlights),
    attributes: input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes) ? input.attributes as Record<string, unknown> : {},
    images: imageUrl ? [{ name: '商品图片URL', type: 'image/url', size: 0, updatedAt: new Date().toISOString(), url: imageUrl }] : [],
    videos: [],
    documents: [],
    factoryImages: [],
    packagingImages: [],
    certificateImages: [],
    sceneImages: [],
    brandAssets: [],
  };
}

function upsertProductItems(existing: NonNullable<EnterpriseProfile['products']['items']>, incoming: NonNullable<EnterpriseProfile['products']['items']>) {
  const next = [...existing];
  for (const product of incoming) {
    const sku = product.sku?.trim();
    const index = sku
      ? next.findIndex(item => item.sku?.trim() === sku)
      : next.findIndex(item => item.name?.trim() === product.name?.trim());
    if (index >= 0) next[index] = mergeEnterpriseProductIdentity(next[index], product, index);
    else next.push(product);
  }
  return next;
}

export function updateEnterpriseProfile(patch: Partial<EnterpriseProfile>): EnterpriseProfile {
  const next = normalizeProfile({ ...readProfile(), ...patch } as EnterpriseProfile);
  writeProfile(next);
  return next;
}

export const enterpriseRouter = Router();
enterpriseRouter.use(requireAuth);
enterpriseRouter.use('/product-footage', createEnterpriseProductFootageImportRouter(store));

async function customerServiceRuntimeStatus(tenantId: string, profile: EnterpriseProfile) {
  const status = customerServiceStatus(profile);
  const messagingAuthorization = await readCustomerMessagingAuthorization(tenantId);
  const messengerAuthorization = await readCustomerMessagingAuthorization(tenantId, 'messenger');
  const instagramAuthorization = await readCustomerMessagingAuthorization(tenantId, 'instagram');
  return {
    ...status,
    autoReplyReady: status.autoReplyReady && messagingAuthorization.inboundAutoSendAllowed,
    messagingAuthorization,
    messengerAuthorization,
    instagramAuthorization,
  };
}

enterpriseRouter.get('/profile', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const profile = await readTenantProfile(tenantId);
  res.setHeader('ETag', `"${profile.factVersion!.contentHash}"`);
  res.json(profile);
});

enterpriseRouter.get('/facts', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const facts = await readTenantEnterpriseFacts(tenantId);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('ETag', `"${facts.version.contentHash}"`);
  res.json(facts);
});

enterpriseRouter.get('/customer-service/status', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  res.setHeader('Cache-Control', 'no-store');
  const profile = await readTenantProfile(tenantId);
  res.json(await customerServiceRuntimeStatus(tenantId, profile));
});

enterpriseRouter.patch('/customer-service/status', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  try {
    const current = await readTenantProfile(tenantId);
    const now = new Date().toISOString();
    let settings = normalizeCustomerServiceSettings(current.customerService);
    let strategy = { ...(current.strategy ?? {}), aiAutonomy: normalizeAutonomy(current.strategy?.aiAutonomy) };

    if (typeof req.body?.enabled === 'boolean' && req.body.enabled !== settings.enabled) {
      settings = req.body.enabled
        ? {
          enabled: true,
          enabledAt: now,
          disabledAt: settings.disabledAt || '',
          partialAutoReplyEnabled: false,
          partialAutoReplyDecision: 'pending',
          partialAutoReplyDecisionAt: '',
        }
        : {
          enabled: false,
          enabledAt: '',
          disabledAt: now,
          partialAutoReplyEnabled: false,
          partialAutoReplyDecision: 'pending',
          partialAutoReplyDecisionAt: '',
        };
      strategy = { ...strategy, aiAutonomy: 'draft' };
    }

    const decision = req.body?.partialAutoReplyDecision;
    if (decision === 'enabled' || decision === 'declined') {
      const policy = customerServicePolicyFromSettings(settings);
      if (!policy.enabled) {
        res.status(409).json({ error: 'customer_service_disabled', message: '请先开启智能客服。' });
        return;
      }
      if (!policy.eligibleForPartialAutoReply) {
        res.status(409).json({
          error: 'observation_period_active',
          message: `建议模式还需运行 ${policy.remainingHours} 小时，暂不能开放直接回复。`,
          status: customerServiceStatus({ ...current, customerService: settings }),
        });
        return;
      }
      settings = {
        ...settings,
        partialAutoReplyEnabled: decision === 'enabled',
        partialAutoReplyDecision: decision,
        partialAutoReplyDecisionAt: now,
      };
      strategy = { ...strategy, aiAutonomy: decision === 'enabled' ? 'auto' : 'draft' };
    }

    const profile = markProfileSaved(normalizeProfile({
      ...current,
      strategy,
      customerService: settings,
    }), 'enterprise_center');
    await writeTenantProfile(tenantId, profile, userId);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, status: await customerServiceRuntimeStatus(tenantId, profile), profile });
  } catch (error) {
    console.error('[enterprise] customer service status update failed', error);
    res.status(503).json({ error: 'tenant_profile_storage_unavailable', message: '智能客服设置暂时无法保存，请稍后重试。' });
  }
});

enterpriseRouter.post('/style-profile/distill', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  try {
    const { distillSalesStyleProfile } = await import('../knowledge/styleMemory.js');
    const profile = await distillSalesStyleProfile(tenantId, true);
    if (!profile) {
      res.status(409).json({ error: 'not_enough_samples', message: '修改样本不足 20 条，暂时无法生成销售风格档案。' });
      return;
    }
    res.json({ ok: true, salesStyleProfile: profile });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'style_profile_distill_failed' });
  }
});

enterpriseRouter.get('/knowledge-completion', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const profile = await readTenantProfile(tenantId);
  res.json(knowledgeCompletion(profile));
});

enterpriseRouter.post('/knowledge-intake/extract', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  try {
    const [{ getWhatsAppKnowledgeSamples, getWhatsAppWinningStyleSamples }, { extractKnowledgeFromHistory }, { importWinningStyleMemories }] = await Promise.all([
      import('../whatsapp/historyImport.js'),
      import('../knowledge/intake.js'),
      import('../knowledge/styleMemory.js'),
    ]);
    const profile = await readTenantProfile(tenantId);
    const samples = getWhatsAppKnowledgeSamples(tenantId, { maxConversations: 60, maxMessages: 500, sinceDays: 180 });
    const preview = await extractKnowledgeFromHistory(profile, samples);
    const winningStyleSamples = getWhatsAppWinningStyleSamples(tenantId, 200);
    const styleSamplesImported = await importWinningStyleMemories(tenantId, winningStyleSamples);
    res.json({
      ...preview,
      styleSamplesImported,
      winningStyleSamplesFound: winningStyleSamples.length,
      styleFactsExcluded: true,
    });
  } catch (error) {
    console.error('[knowledge-intake] extract failed:', error);
    res.status(500).json({
      error: 'knowledge_extraction_failed',
      message: error instanceof Error ? error.message : '暂时无法整理历史聊天，请稍后重试。',
    });
  }
});

enterpriseRouter.post('/knowledge-intake/draft', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  try {
    const { draftKnowledgeFromProducts } = await import('../knowledge/intake.js');
    const profile = await readTenantProfile(tenantId);
    res.json(await draftKnowledgeFromProducts(profile));
  } catch (error) {
    console.error('[knowledge-intake] product draft failed:', error);
    res.status(500).json({
      error: 'knowledge_draft_failed',
      message: error instanceof Error ? error.message : '暂时无法生成初稿，请稍后重试。',
    });
  }
});

enterpriseRouter.post('/knowledge-intake/apply', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const profile = await readTenantProfile(tenantId);
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const companyIntro = text(body.companyIntro);
  const rawRules = body.bizRules && typeof body.bizRules === 'object' ? body.bizRules as Record<string, unknown> : {};
  const nextRules: BizRules = normalizeBizRules({
    ...(profile.bizRules ?? DEFAULT_BIZ_RULES),
    ...(rawRules.quoteMode === 'range' || rawRules.quoteMode === 'human_only' ? { quoteMode: rawRules.quoteMode } : {}),
    ...(rawRules.bargainPolicy === 'no' || rawRules.bargainPolicy === 'limited' || rawRules.bargainPolicy === 'open' ? { bargainPolicy: rawRules.bargainPolicy } : {}),
    ...(['priceRange', 'bargainFloor', 'moq', 'samplePolicy', 'paymentTerms', 'leadTime'] as const).reduce<Record<string, string>>((acc, key) => {
      if (key in rawRules) acc[key] = text(rawRules[key]);
      return acc;
    }, {}),
  } as BizRules, profile.products, profile.operations ?? {});

  const incomingFaqs: FaqItem[] = (Array.isArray(body.faqs) ? body.faqs : [])
    .map(item => item && typeof item === 'object' ? item as Record<string, unknown> : {})
    .map(item => ({
      id: text(item.id) || randomUUID(),
      question: text(item.question),
      answer: text(item.answer),
      approvedForAuto: item.approvedForAuto === true,
      source: item.source === 'learned' ? 'learned' as const : 'manual' as const,
    }))
    .filter(item => item.question && item.answer);
  const nextFaqs = [...(profile.faq ?? [])];
  let importedFaqs = 0;
  incomingFaqs.forEach(item => {
    const index = nextFaqs.findIndex(existing => text(existing.question).toLowerCase() === item.question.toLowerCase());
    if (index >= 0) nextFaqs[index] = { ...nextFaqs[index], ...item, id: nextFaqs[index].id };
    else {
      nextFaqs.push(item);
      importedFaqs += 1;
    }
  });

  const rawNotifications = body.notifications && typeof body.notifications === 'object'
    ? body.notifications as Partial<NotificationSettings>
    : null;
  const existingReceivers = profile.notifications?.receivers ?? [];
  const incomingReceivers = Array.isArray(rawNotifications?.receivers) ? rawNotifications.receivers : [];
  const mergedReceivers = [...existingReceivers];
  incomingReceivers.forEach(receiver => {
    const normalizedTarget = text(receiver?.target);
    if (!normalizedTarget) return;
    const index = mergedReceivers.findIndex(existing => existing.channel === receiver.channel && text(existing.target) === normalizedTarget);
    if (index >= 0) mergedReceivers[index] = receiver;
    else mergedReceivers.push(receiver);
  });
  const notifications = rawNotifications
    ? normalizeNotifications({
      ...(profile.notifications ?? DEFAULT_NOTIFICATIONS),
      ...rawNotifications,
      receivers: mergedReceivers,
      workHours: {
        ...(profile.notifications?.workHours ?? DEFAULT_NOTIFICATIONS.workHours),
        ...(rawNotifications.workHours ?? {}),
      },
    })
    : profile.notifications;
  const confirmedSections = Array.isArray(body.confirmedSections)
    ? Array.from(new Set([
      ...(profile.knowledgeIntake?.confirmedSections ?? []),
      ...body.confirmedSections.map(text).filter(Boolean),
    ])).slice(0, 12)
    : profile.knowledgeIntake?.confirmedSections ?? [];
  const source = body.source === 'history' || body.source === 'products' || body.source === 'interview'
    ? body.source
    : profile.knowledgeIntake?.source;
  const extractedMessages = Math.max(0, Number(body.extractedMessages || 0) || 0);

  const nextProfile = markProfileSaved(normalizeProfile({
    ...profile,
    company: {
      ...profile.company,
      description: companyIntro || profile.company.description,
    },
    bizRules: nextRules,
    faq: nextFaqs,
    notifications,
    knowledgeIntake: {
      ...profile.knowledgeIntake,
      lastExtractedAt: new Date().toISOString(),
      source,
      extractedMessages: extractedMessages || profile.knowledgeIntake?.extractedMessages || 0,
      confirmedSections,
    },
  }), 'knowledge_intake');
  await writeTenantProfile(tenantId, nextProfile, userId);
  res.json({
    ok: true,
    profile: nextProfile,
    importedFaqs,
    completion: knowledgeCompletion(nextProfile),
  });
});

enterpriseRouter.post('/faq/structure', async (req, res) => {
  const source = text(req.body?.text);
  if (!source) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const items = await structureFaqText(source);
  res.json({ items });
});

enterpriseRouter.get('/faq/packs', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const profile = await readTenantProfile(tenantId);
  res.json({
    recommendedIndustry: inferIndustry(profile),
    packs: allPackPreviews(profile),
  });
});

enterpriseRouter.post('/faq/packs/import', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const profile = await readTenantProfile(tenantId);
  const industry = text(req.body?.industry) as PackIndustry;
  const scenario = text(req.body?.scenario) as PackScenario;
  const selected = Array.isArray(req.body?.questions) ? req.body.questions.map(text).filter(Boolean) : [];
  if (!(industry in INDUSTRY_LABELS) || !(scenario in SCENARIO_LABELS)) {
    res.status(400).json({ error: 'invalid_pack' });
    return;
  }
  const pack = buildPackPreview(profile, industry, scenario);
  const selectedSet = new Set(selected.map((item: string) => item.toLowerCase()));
  const existing = new Set((profile.faq ?? []).map(item => text(item.question).toLowerCase()).filter(Boolean));
  const incoming: FaqItem[] = pack.items
    .filter((item: ReturnType<typeof fillPackEntry> & { exists?: boolean }) => item.ready && !item.exists && (!selected.length || selectedSet.has(item.q.toLowerCase())))
    .map((item): FaqItem => ({
      id: randomUUID(),
      question: item.q,
      answer: item.a,
      approvedForAuto: false,
      source: 'pack',
    }))
    .filter(item => {
      const key = item.question.toLowerCase();
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
  const nextProfile = { ...profile, faq: [...(profile.faq ?? []), ...incoming] };
  await writeTenantProfile(tenantId, nextProfile, userId);
  res.json({
    ok: true,
    imported: incoming.length,
    skipped: pack.items.length - incoming.length,
    profile: nextProfile,
  });
});

enterpriseRouter.post('/faq/learned', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const profile = await readTenantProfile(tenantId);
  const buyerMessage = text(req.body?.buyerMessage);
  const answer = text(req.body?.answer);
  const questionInput = text(req.body?.question);
  if (!buyerMessage || !answer) {
    res.status(400).json({ error: 'buyer_message_and_answer_required' });
    return;
  }
  let question = questionInput;
  if (!question) {
    try {
      const prompt = [
        '把买家原话概括成一句中文常见问题，适合放进企业知识库 FAQ。',
        '只返回问题本身，不要解释，不要加引号。',
        `买家原话：${buyerMessage}`,
      ].join('\n');
      question = text(await callLLM(prompt, { backend: 'qwen', model: process.env.KNOWLEDGE_QUERY_MODEL || 'qwen-plus' }));
    } catch {
      question = buyerMessage.length > 60 ? `${buyerMessage.slice(0, 57)}...` : buyerMessage;
    }
  }
  const existing = new Set((profile.faq ?? []).map(item => text(item.question).toLowerCase()).filter(Boolean));
  if (existing.has(question.toLowerCase())) {
    res.json({ ok: true, skipped: true, profile, item: (profile.faq ?? []).find(item => text(item.question).toLowerCase() === question.toLowerCase()) });
    return;
  }
  const item: FaqItem = {
    id: randomUUID(),
    question,
    answer,
    approvedForAuto: false,
    source: 'learned',
  };
  const nextProfile = { ...profile, faq: [...(profile.faq ?? []), item] };
  await writeTenantProfile(tenantId, nextProfile, userId);
  res.json({ ok: true, item, profile: nextProfile });
});

enterpriseRouter.post('/faq/learned/suggest', async (req, res) => {
  const buyerMessage = text(req.body?.buyerMessage);
  if (!buyerMessage) {
    res.status(400).json({ error: 'buyer_message_required' });
    return;
  }
  try {
    const prompt = [
      '把买家原话概括成一句中文常见问题，适合放进企业知识库 FAQ。',
      '只返回问题本身，不要解释，不要加引号。',
      `买家原话：${buyerMessage}`,
    ].join('\n');
    const question = text(await callLLM(prompt, { backend: 'qwen', model: process.env.KNOWLEDGE_QUERY_MODEL || 'qwen-plus' }));
    res.json({ question: question || buyerMessage });
  } catch {
    res.json({ question: buyerMessage.length > 60 ? `${buyerMessage.slice(0, 57)}...` : buyerMessage });
  }
});

enterpriseRouter.post('/notifications/test', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const profile = await readTenantProfile(tenantId);
  const receiver = req.body?.receiver as Partial<NotificationReceiver> | undefined;
  const target = text(receiver?.target);
  const name = text(receiver?.name) || '通知接收人';
  const channel = normalizeNotificationChannel(receiver?.channel);
  if (!target) {
    res.status(400).json({ error: 'receiver target is required' });
    return;
  }
  const normalizedReceiver: NotificationReceiver = { name, channel, target };
  try {
    await notifyDeliveryTeam(`[灵枢测试提醒] ${name} (${channel}/${target}) 已接入重要客户提醒。`, {
      immediate: true,
      receivers: [normalizedReceiver],
    });
  } catch (error) {
    res.status(502).json({
      error: 'notification_test_failed',
      message: channel === 'sms'
        ? '短信通道尚未接入供应商，请先改用钉钉、飞书或企业微信群机器人 Webhook。'
        : `测试消息没有真正送达：${error instanceof Error ? error.message : 'unknown_error'}`,
    });
    return;
  }
  const receivers = [...(profile.notifications?.receivers ?? [])];
  const receiverIndex = receivers.findIndex(item => item.channel === channel && text(item.target) === target);
  if (receiverIndex >= 0) receivers[receiverIndex] = normalizedReceiver;
  else receivers.push(normalizedReceiver);
  const notifications = normalizeNotifications({
    ...(profile.notifications ?? DEFAULT_NOTIFICATIONS),
    receivers,
    lastTestAt: new Date().toISOString(),
  });
  await writeTenantProfile(tenantId, { ...profile, notifications }, userId);
  res.json({ ok: true, lastTestAt: notifications.lastTestAt, notifications });
});

registerEnterpriseOrderRoutes(enterpriseRouter);

enterpriseRouter.use('/product-api', enterpriseProductApiRouter);

enterpriseRouter.get('/product-api/status', async (_req, res) => {
  try {
    const { tenantId } = res.locals as AuthLocals;
    const result = await withLegacyExternalEffectAllowed(tenantId, async () => {
      const profile = await readTenantProfile(tenantId);
      const items = profile.products.items ?? [];
      const secret = await productApiSecretForTenant(tenantId);
      return {
        count: items.length,
        lastIngestedAt: secret?.lastIngestedAt || '',
        lastProductName: secret?.lastProductName || items.at(-1)?.name || '',
      };
    });
    res.json(result);
  } catch (error) {
    respondLegacyProductApiFailure(error, res);
  }
});

registerEnterpriseAssetRoutes(enterpriseRouter);

function enterpriseFactVersionMatchesRequest(req: Request, current: EnterpriseProfile): boolean {
  const expected = normalizeExpectedFactVersion(req.header('if-match'));
  return !expected || expected === current.factVersion?.contentHash || expected === current.factVersion?.id;
}

enterpriseRouter.post('/profile', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  try {
    const current = await readTenantProfile(tenantId);
    if (!enterpriseFactVersionMatchesRequest(req, current)) {
      res.status(409).json({
        error: 'enterprise_fact_version_conflict',
        message: '企业资料已由其他页面更新，请刷新后再保存。',
        factVersion: current.factVersion,
      });
      return;
    }
    const profile = markProfileSaved(normalizeProfile({
      ...(req.body as EnterpriseProfile),
      customerService: current.customerService,
    }), 'enterprise_center');
    await writeTenantProfile(tenantId, profile, userId, normalizeExpectedFactVersion(req.header('if-match')));
    res.json({ ok: true, profile });
  } catch (error) {
    if (error instanceof EnterpriseFactVersionConflictError) {
      res.status(409).json({ error: error.message, message: '企业资料已由其他页面更新，请刷新后再保存。', factVersion: error.current });
      return;
    }
    console.error('[enterprise] profile save failed', error);
    res.status(503).json({ error: 'tenant_profile_storage_unavailable', message: '企业资料暂时无法保存，请稍后重试' });
  }
});

enterpriseRouter.patch('/profile', async (req, res) => {
  const { tenantId, userId } = res.locals as AuthLocals;
  const source = req.header('x-enterprise-save-source') === 'diagnosis' ? 'diagnosis' : 'enterprise_center';
  try {
    const current = await readTenantProfile(tenantId);
    if (!enterpriseFactVersionMatchesRequest(req, current)) {
      res.status(409).json({
        error: 'enterprise_fact_version_conflict',
        message: '企业资料已由其他页面更新，请刷新后再保存。',
        factVersion: current.factVersion,
      });
      return;
    }
    const profile = markProfileSaved(normalizeProfile({
      ...mergeEnterpriseProfile(current, req.body as Partial<EnterpriseProfile>),
      customerService: current.customerService,
    }), source);
    await writeTenantProfile(tenantId, profile, userId, normalizeExpectedFactVersion(req.header('if-match')));
    res.json({ ok: true, profile });
  } catch (error) {
    if (error instanceof EnterpriseFactVersionConflictError) {
      res.status(409).json({ error: error.message, message: '企业资料已由其他页面更新，请刷新后再保存。', factVersion: error.current });
      return;
    }
    console.error('[enterprise] profile patch failed', error);
    res.status(503).json({ error: 'tenant_profile_storage_unavailable', message: '企业资料暂时无法保存，请稍后重试' });
  }
});

enterpriseRouter.get('/context', async (_req, res) => {
  const { tenantId } = res.locals as AuthLocals;
  const facts = await readTenantEnterpriseFacts(tenantId);
  res.json({ context: facts.context, factVersion: facts.version });
});

export const productApiRouter = Router();

productApiRouter.post('/bulk', async (req, res) => {
  try {
    const verified = await verifyProductApiKey(req);
    if (!verified) {
      res.status(401).json({ error: 'Invalid API Key' });
      return;
    }
    const { secret } = verified;
    const payload = Array.isArray(req.body) ? req.body : req.body?.products;
    if (!Array.isArray(payload)) {
      res.status(400).json({ error: 'Body should be { products: [...] } or an array.' });
      return;
    }
    const products = payload.map(item => normalizeApiProduct(item)).filter(Boolean) as NonNullable<EnterpriseProfile['products']['items']>;
    const total = await withLegacyExternalEffectAllowed(secret.tenantId, async guard => {
      const profile = await readTenantProfile(secret.tenantId);
      const nextItems = upsertProductItems(profile.products.items ?? [], products);
      const last = products.at(-1);
      await guard.beforeEffect();
      await writeTenantProfile(secret.tenantId, { ...profile, products: { ...profile.products, items: nextItems } }, 'product-api');
      const keyRecord = await store.list<Record<string, unknown>>('tenant_api_keys', { where: { tenant_id: secret.tenantId }, page: 1, perPage: 1 });
      if (keyRecord.items[0]?.id) {
        await guard.beforeEffect();
        await store.update('tenant_api_keys', String(keyRecord.items[0].id), { last_ingested_at: new Date().toISOString(), last_product_name: last?.name || '' });
      }
      return nextItems.length;
    });
    res.json({ ok: true, received: payload.length, upserted: products.length, total });
  } catch (error) {
    respondLegacyProductApiFailure(error, res);
  }
});

productApiRouter.get('/', async (req, res) => {
  try {
    const verified = await verifyProductApiKey(req);
    if (!verified) {
      res.status(401).json({ error: 'Invalid API Key' });
      return;
    }
    const { profile } = verified;
    const sku = text(req.query.sku);
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const items = (profile.products.items ?? []).filter(item => !sku || item.sku === sku).slice(0, limit);
    res.json({ total: items.length, items });
  } catch (error) {
    respondLegacyProductApiFailure(error, res);
  }
});

productApiRouter.delete('/:sku?', async (req, res) => {
  try {
    const verified = await verifyProductApiKey(req);
    if (!verified) {
      res.status(401).json({ error: 'Invalid API Key' });
      return;
    }
    const { secret } = verified;
    const sku = text(req.params.sku || req.query.sku || req.body?.sku);
    if (!sku) {
      res.status(400).json({ error: 'Missing sku' });
      return;
    }
    const result = await withLegacyExternalEffectAllowed(secret.tenantId, async guard => {
      const profile = await readTenantProfile(secret.tenantId);
      const before = profile.products.items ?? [];
      const after = before.filter(item => item.sku !== sku);
      await guard.beforeEffect();
      await writeTenantProfile(secret.tenantId, { ...profile, products: { ...profile.products, items: after } }, 'product-api');
      return { deleted: before.length - after.length, total: after.length };
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    respondLegacyProductApiFailure(error, res);
  }
});
