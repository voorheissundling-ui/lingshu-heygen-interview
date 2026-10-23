import { customers, interactions, whatsappInteractionProviderId } from './historyPersistence.js';
import { autonomyLevel, handoffRules, matchedHandoffKeyword, nightModeState, recordNightModeEvent, text, timestamp } from './historyPolicy.js';
import { addInteraction, customerId, upsertCustomer } from './historyCustomerState.js';
import { approvedFaqAnswer, autoFaqLibraryReady, draftForMessage, evaluateCustomerHandoff, handoffCustomerContext, inferActionFromText, recentConversationForCustomer } from './historyInboundPreparation.js';
import { decideAction, findActionRule, type AutonomyLevel } from '../autonomy/actionRules.js';
import { guardOutbound } from '../autonomy/outboundGuard.js';
import { ambiguousFaqClarification, resolveKnowledgeGapPlan, scenarioHasGroundedEvidence } from '../agents/knowledgeGapPlaybook.js';
import { retrieveContext } from '../knowledge/retrieve.js';
import { customerServicePolicy, readTenantEnterpriseProfile } from '../routes/enterprise.js';
import { assessBant, selectProgressionGoal } from '../sales/qualification.js';
import { automationFailureHandoff, notifyCustomerHandoff, shouldRestrictToPublicInfo } from '../sales/handoff.js';
import { advanceSpinStage, selectSpinGuidance } from '../sales/spin.js';
import { matchSalesActions, shouldEscalateSalesAction } from '../sales/actionLibrary.js';
import { store } from '../storage/index.js';
import { createCustomerManualTakeoverService } from '../customerService/customerManualTakeover.js';
import { sendTenantWhatsAppTextWithReceipts } from './send.js';
import { deliverAutoReply } from './autoReplyDelivery.js';
import { readCustomerMessagingAuthorization } from '../digitalEmployees/customerMessagingPolicy.js';
import { attributionSystemText, extractTrackCode, findPostByTrackCode, incrementPostMetric, recentPostCandidates, sourceFromPost, type PostRecord } from '../publishing/waLink.js';
import type { IncomingMessage, StoredCustomer } from './historyImport.js';

export async function handleInboundMessage(tenantId: string, message: IncomingMessage, options: { skipAutonomy?: boolean } = {}): Promise<void> {
  // Meta retries the same event. Do not re-open inbox tasks, advance customer
  // qualification, or send another reply for an already recorded message.
  if (interactions().some(item => item.tenantId === tenantId && String(item.audit?.phoneNumberId||'')===String(message.canonicalAccount?.phoneNumberId||'') && whatsappInteractionProviderId(item) === message.id)) return;
  const existingCustomer = customers().find(item => item.tenantId === tenantId && item.id === customerId(tenantId, message.waNumber));
  let attributedPost: PostRecord | null = null;
  const attributionPatch: Partial<StoredCustomer> = {};
  if (!message.fromBusiness && !existingCustomer && !options.skipAutonomy) {
    const trackCode = extractTrackCode(message.body);
    if (trackCode) {
      attributedPost = await findPostByTrackCode(tenantId, trackCode);
      if (attributedPost) {
        attributionPatch.source = sourceFromPost(attributedPost);
        attributionPatch.sourcePostId = attributedPost.id;
        attributionPatch.sourceTrackCode = attributedPost.track_code;
        attributionPatch.sourcePostTitle = attributedPost.title || attributedPost.track_code;
        attributionPatch.sourcePostPlatform = attributedPost.platform;
        attributionPatch.handlingReason = `客户来自${attributedPost.platform}内容《${attributedPost.title || attributedPost.track_code}》`;
      }
    } else {
      const candidates = await recentPostCandidates(tenantId, 72);
      if (candidates.length) {
        attributionPatch.softAttribution = {
          candidates: candidates.slice(0, 5).map(post => ({
            id: post.id,
            title: post.title || post.track_code,
            platform: post.platform,
            trackCode: post.track_code,
          })),
        };
      }
    }
  }
  let customer = upsertCustomer({
    tenantId,
    waNumber: message.waNumber,
    name: message.name,
    body: message.body,
    lastActiveAt: message.timestamp,
    patch: {
      ...attributionPatch,
      ...(!message.fromBusiness ? { hasUnread: true, todoCompletedAt: undefined } : {}),
    },
  });
  const inserted = addInteraction({
    id: `${customer.id}-${message.canonicalAccount?.phoneNumberId?message.canonicalAccount.phoneNumberId+'-':''}${message.id}`,
    tenantId,
    customerId: customer.id,
    waNumber: message.waNumber,
    metaMessageId: message.id,
    type: message.fromBusiness ? 'msg_out_human' : 'msg_in',
    body: message.body,
    timestamp: message.timestamp,
    audit: message.canonicalAccount?{providerMessageId:message.id,providerRecipientId:message.waNumber,accountId:message.canonicalAccount.accountId,phoneNumberId:message.canonicalAccount.phoneNumberId,wabaId:message.canonicalAccount.wabaId,inboundSource:'verified_meta_webhook'}:{},
  });
  if (!inserted) return; // Another request may have won while attribution awaited.
  const conversationForQualification = recentConversationForCustomer(tenantId, customer.id);
  const qualification = assessBant({
    turns: conversationForQualification,
    previous: customer.bant,
  });
  const progressionGoal = selectProgressionGoal(qualification, customer.language);
  const spinState = advanceSpinStage({
    previous: customer.spin,
    turns: conversationForQualification,
    bant: qualification,
    isNewBuyerTurn: !message.fromBusiness,
  });
  const spinTimeline = conversationForQualification.map(turn => ({ actor: turn.role === 'seller' ? 'seller' : 'buyer', body: turn.text }));
  const spinGuidance = selectSpinGuidance(spinState, customer.language, spinTimeline);
  customer = upsertCustomer({
    tenantId,
    waNumber: message.waNumber,
    patch: {
      bant: qualification,
      progressionGoal,
      spin: spinState,
      spinGuidance,
      intentScore: qualification.total,
    },
  });
  if (attributedPost) {
    await incrementPostMetric(attributedPost.id, 'inquiries');
    addInteraction({
      id: `${customer.id}-source-${attributedPost.track_code}-${Date.now()}`,
      tenantId,
      customerId: customer.id,
      waNumber: message.waNumber,
      type: 'system',
      body: attributionSystemText(attributedPost),
      timestamp: Date.now(),
      audit: { sourcePostId: attributedPost.id, trackCode: attributedPost.track_code, platform: attributedPost.platform },
      meta: { sourcePostId: attributedPost.id, trackCode: attributedPost.track_code, platform: attributedPost.platform },
    });
  }
  if (message.fromBusiness) {
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: { knowledgeMissStreak: 0, fallbackCount: 0, blockedAutoReplyReason: undefined, handoffDueAt: undefined },
    });
    return;
  }
  if (options.skipAutonomy) return;
  if (customer.handlingMode==='human_needed') return;

  const profile = await readTenantEnterpriseProfile(tenantId);
  const servicePolicy = customerServicePolicy(profile);
  if (!servicePolicy.enabled) {
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: {
        handlingMode: 'human_needed',
        handlingReason: '智能客服未开启，客户消息已进入收件箱等待人工回复',
        pendingDraft: undefined,
        blockedAutoReplyReason: undefined,
      },
    });
    return;
  }
  const messagingAuthorization = await readCustomerMessagingAuthorization(tenantId);
  const autonomy = autonomyLevel(profile);
  const rules = handoffRules(profile);
  const handoffKeyword = matchedHandoffKeyword(message.body, rules.keywords);
  if (handoffKeyword) {
    const reason = `客户主动要求人工/触发关键词【${handoffKeyword}】`;
    const handoffDecision = evaluateCustomerHandoff(customer, { message: message.body, requestedHuman: true });
    addInteraction({
      id: `${customer.id}-handoff-keyword-${Date.now()}`,
      tenantId,
      customerId: customer.id,
      waNumber: message.waNumber,
      type: 'system',
      body: reason,
      timestamp: Date.now(),
      audit: { handoff: true, reason, keyword: handoffKeyword },
      meta: { handoff: true, reason, keyword: handoffKeyword },
    });
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: {
        handlingMode: 'human_needed',
        handlingReason: reason,
        pendingDraft: undefined,
        blockedAutoReplyReason: reason,
      },
    });
    await notifyCustomerHandoff({
      tenantId,
      customer: handoffCustomerContext(customer),
      message: message.body,
      decision: handoffDecision,
    }).catch(() => undefined);
    return;
  }

  const inferredAction = inferActionFromText(message.body);
  const recentConversation = recentConversationForCustomer(tenantId, customer.id);
  const context = await retrieveContext(tenantId, {
    id: customer.id,
    name: customer.name,
    language: customer.language,
    stage: customer.stage,
  }, message.body, { conversation: recentConversation });
  const matchedSalesActions = matchSalesActions({
    message: message.body,
    firstTurn: recentConversation.filter(turn => turn.role === 'buyer').length <= 1,
    stage: customer.stage,
    knowledgeMiss: context.knowledgeMiss,
    productAvailable: context.products.length > 0,
    redFlagCount: customer.bant?.authenticity.redFlags.length ?? 0,
    fallbackCount: customer.fallbackCount ?? 0,
    sentiment: context.sentiment,
  });
  const escalatedSalesActions = matchedSalesActions.filter(item => shouldEscalateSalesAction(item, message.body));
  const nextMissStreak = context.knowledgeMiss ? (customer.knowledgeMissStreak ?? 0) + 1 : 0;
  const nextFallbackCount = (customer.fallbackCount ?? 0) + 1;
  const gapPlan = resolveKnowledgeGapPlan({
    message: message.body,
    language: customer.language,
    timeline: recentConversation.map(turn => ({ actor: turn.role, body: turn.text })),
  });
  const enterpriseEvidenceSource = JSON.stringify({
    company: context.companyIntro,
    businessRules: context.bizRules,
    matchedFaq: context.faqMatch,
    products: context.products,
  });
  const predictableGapWithoutEvidence = gapPlan.scenario !== 'general_unknown'
    && !scenarioHasGroundedEvidence(gapPlan.scenario, enterpriseEvidenceSource);
  const needsFaqClarification = Boolean(context.faqMatch && (context.faqMatch.ambiguous || context.faqMatch.confidence < 0.75));
  if (!needsFaqClarification && (context.knowledgeMiss || predictableGapWithoutEvidence)) {
    const mustHandoffGap = escalatedSalesActions.length > 0 || nextFallbackCount >= 2;
    if (!mustHandoffGap) {
      addInteraction({
        id: `${customer.id}-knowledge-gap-draft-${Date.now()}`,
        tenantId,
        customerId: customer.id,
        waNumber: message.waNumber,
        type: 'system',
        body: '知识库暂未覆盖，已生成不承诺业务事实的待确认短回复。',
        timestamp: Date.now(),
        audit: {
          knowledgeMiss: context.knowledgeMiss,
          buyerMessage: message.body,
          scenario: gapPlan.scenario,
          replyConfidence: gapPlan.replyConfidence,
          fallbackCount: nextFallbackCount,
          matchedSalesActions: matchedSalesActions.map(item => item.id),
          translatedDraft: gapPlan.draftZh,
        },
      });
      upsertCustomer({
        tenantId,
        waNumber: message.waNumber,
        patch: {
          handlingMode: 'ai_draft',
          handlingReason: '知识库暂未覆盖，等待确认承接回复',
          pendingDraft: gapPlan.draft,
          blockedAutoReplyReason: 'knowledge_gap_draft',
          knowledgeMissStreak: nextMissStreak,
          fallbackCount: nextFallbackCount,
          handoffDueAt: gapPlan.followUpDueAt,
        },
      });
      return;
    }
    const handoffDecision = evaluateCustomerHandoff(customer, {
      message: message.body,
      sentiment: context.sentiment,
      knowledgeMissStreak: nextMissStreak,
      fallbackCount: nextFallbackCount,
      knowledgeGap: true,
      salesActions: escalatedSalesActions,
    });
    const guard = await guardOutbound(gapPlan.draft, { tenantId, customerId: customer.id, action: 'knowledge_gap_bridge' });
    const shouldAutoBridge = autonomy === 'auto'
      && messagingAuthorization.inboundAutoSendAllowed
      && gapPlan.safeToSendBeforeHandoff
      && guard.allowed;
    let bridgeSent = false;
    let bridgeMessages: string[] = [];
    let bridgeReceipts: Array<{ messageId: string; recipientId?: string; raw?: unknown }> = [];
    let bridgeFailureReason = '';
    if (shouldAutoBridge) {
      const delivery = await createCustomerManualTakeoverService(store).withAutoSendPermission({tenantId,customerId:customer.id,channel:'whatsapp'},()=>deliverAutoReply({ tenantId, to: message.waNumber, body: gapPlan.draft,
        recordAccepted: ({ message: body, receipt, index, total }) => {
          bridgeMessages.push(body); bridgeReceipts.push(receipt);
          addInteraction({ id: `${customer.id}-ai-${receipt.messageId}`, tenantId, customerId: customer.id,
            waNumber: message.waNumber, type: 'msg_out_ai', body, timestamp: Date.now(), autoSent: true,
            audit: { knowledgeMiss: context.knowledgeMiss, buyerMessage: message.body, scenario: gapPlan.scenario,
              bridgeOnly: true, handoff: true, translatedDraft: gapPlan.draftZh, replyConfidence: gapPlan.replyConfidence,
              evidence: context.evidence, providerMessageId: bridgeReceipts[index]?.messageId,
              providerRecipientId: receipt.recipientId, messageIndex: index, messageCount: total },
            meta: { provider: 'whatsapp', providerMessageId: receipt.messageId, providerRecipientId: receipt.recipientId },
          });
        },
      }, sendTenantWhatsAppTextWithReceipts));
      bridgeSent = delivery.complete;
      bridgeFailureReason = delivery.reason;
    }
    addInteraction({
      id: `${customer.id}-knowledge-gap-handoff-${Date.now()}`,
      tenantId,
      customerId: customer.id,
      waNumber: message.waNumber,
      type: 'system',
      body: bridgeSent
        ? `AI 已先承接客户并转人工：${gapPlan.handlingReason}`
        : bridgeFailureReason ? `自动承接回复未完整确认，请先核对已发送记录，已转人工：${gapPlan.handlingReason}`
        : `已生成安全承接草稿并转人工：${gapPlan.handlingReason}`,
      timestamp: Date.now(),
      audit: {
        knowledgeMiss: context.knowledgeMiss,
        buyerMessage: message.body,
        scenario: gapPlan.scenario,
        bridgeSent,
        handoff: true,
        guardRule: guard.allowed ? undefined : guard.matchedRule,
        replyConfidence: gapPlan.replyConfidence,
        fallbackCount: nextFallbackCount,
        handoffDueAt: gapPlan.followUpDueAt,
        translatedDraft: gapPlan.draftZh,
      },
      meta: { handoff: true, scenario: gapPlan.scenario, bridgeSent, knowledgeMiss: true, buyerMessage: message.body },
    });
    if (nightModeState(profile).active) recordNightModeEvent({ tenantId, customerId: customer.id, kind: bridgeSent ? 'auto' : 'draft' });
    await notifyCustomerHandoff({
      tenantId,
      customer: handoffCustomerContext(customer),
      message: message.body,
      decision: handoffDecision,
      bridgeSent,
    }).catch(() => undefined);
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: {
        handlingMode: 'human_needed',
        handlingReason: gapPlan.handlingReason,
        pendingDraft: bridgeSent || bridgeFailureReason ? undefined : gapPlan.draft,
        blockedAutoReplyReason: bridgeFailureReason || (guard.allowed ? 'knowledge_gap_handoff' : guard.matchedRule || 'knowledge_gap_guard'),
        knowledgeMissStreak: nextMissStreak,
        fallbackCount: nextFallbackCount,
        handoffDueAt: gapPlan.followUpDueAt,
      },
    });
    return;
  }
  if (!context.knowledgeMiss && (customer.knowledgeMissStreak ?? 0) > 0) {
    upsertCustomer({ tenantId, waNumber: message.waNumber, patch: { knowledgeMissStreak: 0 } });
  }
  if (rules.negativeSentiment && context.sentiment === 'negative') {
    const reason = '客户情绪负面，建议亲自处理';
    const handoffDecision = evaluateCustomerHandoff(customer, { message: message.body, sentiment: context.sentiment });
    addInteraction({
      id: `${customer.id}-handoff-sentiment-${Date.now()}`,
      tenantId,
      customerId: customer.id,
      waNumber: message.waNumber,
      type: 'system',
      body: reason,
      timestamp: Date.now(),
      audit: { handoff: true, reason, sentiment: context.sentiment, evidence: context.evidence },
      meta: { handoff: true, reason, sentiment: context.sentiment, evidence: context.evidence },
    });
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: {
        handlingMode: 'human_needed',
        handlingReason: reason,
        pendingDraft: undefined,
        blockedAutoReplyReason: 'negative_sentiment',
        knowledgeMissStreak: nextMissStreak,
      },
    });
    await notifyCustomerHandoff({
      tenantId,
      customer: handoffCustomerContext(customer),
      message: message.body,
      decision: handoffDecision,
    }).catch(() => undefined);
    return;
  }
  const salesHandoff = evaluateCustomerHandoff(customer, {
    message: message.body,
    sentiment: context.sentiment,
    salesActions: escalatedSalesActions,
  });
  if (salesHandoff.lines.includes('business_value')) {
    const reason = salesHandoff.reasons.join('；');
    addInteraction({
      id: `${customer.id}-business-value-handoff-${Date.now()}`,
      tenantId,
      customerId: customer.id,
      waNumber: message.waNumber,
      type: 'system',
      body: `高价值商机已立即转人工：${reason}`,
      timestamp: Date.now(),
      audit: { handoff: true, line: 'business_value', severity: 'urgent', bant: customer.bant },
      meta: { handoff: true, line: 'business_value', severity: 'urgent' },
    });
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: { handlingMode: 'human_needed', handlingReason: reason, pendingDraft: undefined, blockedAutoReplyReason: 'business_value_handoff' },
    });
    await notifyCustomerHandoff({
      tenantId,
      customer: handoffCustomerContext(customer),
      message: message.body,
      decision: salesHandoff,
    }).catch(() => undefined);
    return;
  }
  if (escalatedSalesActions.length) {
    const reason = salesHandoff.reasons.join('；') || `命中需人工确认的销售场景：${escalatedSalesActions.map(item => item.id).join('、')}`;
    const handoffDraft = escalatedSalesActions[0]?.talk[0]?.join('\n\n') || draftForMessage(message, context, customer.progressionGoal, customer.spinGuidance);
    addInteraction({
      id: `${customer.id}-sales-action-handoff-${Date.now()}`,
      tenantId,
      customerId: customer.id,
      waNumber: message.waNumber,
      type: 'system',
      body: `销售动作已转人工：${escalatedSalesActions.map(item => `${item.id} ${item.scenario}`).join('、')}`,
      timestamp: Date.now(),
      audit: { handoff: true, actionIds: escalatedSalesActions.map(item => item.id), risk: 'L4', bant: customer.bant },
      meta: { handoff: true, actionIds: escalatedSalesActions.map(item => item.id), severity: salesHandoff.severity },
    });
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: {
        handlingMode: 'human_needed',
        handlingReason: reason,
        pendingDraft: handoffDraft,
        blockedAutoReplyReason: 'sales_action_handoff',
      },
    });
    await notifyCustomerHandoff({
      tenantId,
      customer: handoffCustomerContext(customer),
      message: message.body,
      decision: salesHandoff,
    }).catch(() => undefined);
    return;
  }
  if (salesHandoff.lines.includes('risk')) {
    const restrictToPublicInfoOnly = salesHandoff.riskKind === 'price_or_terms' && shouldRestrictToPublicInfo(customer.bant);
    if (restrictToPublicInfoOnly) {
      // 真实性系数≤0.3（疑似套价/踩点）：不推送人工提醒噪音，只静默标记，继续仅回答公开信息。
      addInteraction({
        id: `${customer.id}-public-info-only-${Date.now()}`,
        tenantId,
        customerId: customer.id,
        waNumber: message.waNumber,
        type: 'system',
        body: '客户信息待核实，AI 继续仅提供公开信息自动应答，不推送人工提醒。',
        timestamp: Date.now(),
        audit: { authenticity: customer.bant?.authenticity, riskKind: salesHandoff.riskKind },
      });
    } else {
      await notifyCustomerHandoff({
        tenantId,
        customer: handoffCustomerContext(customer),
        message: message.body,
        decision: salesHandoff,
      }).catch(() => undefined);
    }
  }
  let action = matchedSalesActions[0] ? `sales:${matchedSalesActions[0].id}` : inferredAction;
  if (context.faqMatch?.autoSafe && action !== 'call_request' && findActionRule(action).risk !== 'L4') {
    action = 'auto_faq_reply';
  }
  const night = nightModeState(profile);
  let draft = draftForMessage(message, context, customer.progressionGoal, customer.spinGuidance);
  let blockedAutoReplyReason = '';
  let approvedFaqHit = false;
  if (needsFaqClarification && action !== 'call_request' && findActionRule(action).risk !== 'L4') {
    action = 'draft_greeting';
    draft = ambiguousFaqClarification(customer.language).draft;
    blockedAutoReplyReason = 'FAQ 匹配置信度低于 0.75，先向客户澄清具体产品和问题';
  }
  if (action === 'call_request') {
    const callDraft = 'I have flagged your call request. What time window works best for you?';
    addInteraction({
      id: `${customer.id}-call-request-${Date.now()}`,
      tenantId,
      customerId: customer.id,
      waNumber: message.waNumber,
      type: 'system',
      body: '客户想通电话，已即时提醒负责人。',
      timestamp: Date.now(),
      audit: { action, risk: 'L4', nightMode: night.active },
    });
    if (night.active) recordNightModeEvent({ tenantId, customerId: customer.id, kind: 'call' });
    await notifyCustomerHandoff({
      tenantId,
      customer: handoffCustomerContext(customer),
      message: message.body,
      decision: evaluateCustomerHandoff(customer, { message: message.body, requestedHuman: true }),
    }).catch(() => undefined);
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: {
        handlingMode: 'human_needed',
        handlingReason: '客户想通电话，已即时提醒负责人',
        pendingDraft: autonomy === 'remind' ? undefined : callDraft,
        needCall: true,
      },
    });
    return;
  }
  if (action === 'auto_faq_reply') {
    const approvedAnswer = approvedFaqAnswer(context, message.body);
    if (approvedAnswer) {
      draft = approvedAnswer;
      approvedFaqHit = true;
    } else {
      action = 'draft_greeting';
      blockedAutoReplyReason = autoFaqLibraryReady(profile)
        ? '未命中已审批常见问答，已降级为草稿'
        : '需要先录入并审批至少 5 条常见问答';
    }
  }
  const faqLibraryReady = autoFaqLibraryReady(profile);
  const configuredAutonomy: AutonomyLevel = autonomy === 'auto' && (!faqLibraryReady || !messagingAuthorization.inboundAutoSendAllowed)
    ? 'draft'
    : autonomy;
  const approvedSafeIntent = action === 'auto_faq_reply' && approvedFaqHit;
  const effectiveAutonomy: AutonomyLevel = configuredAutonomy === 'auto' && !approvedSafeIntent
    ? 'draft'
    : configuredAutonomy;
  const decision = decideAction(action, effectiveAutonomy);
  if (night.active && decision.decision !== 'auto') {
    blockedAutoReplyReason = blockedAutoReplyReason || '夜班模式：非工作时间仅自动回复已审批常见问题和低风险动作';
  } else if (!night.active && configuredAutonomy === 'auto' && !approvedSafeIntent) {
    blockedAutoReplyReason = blockedAutoReplyReason || '负责人工作时间：除高置信已审批 FAQ 外，AI 只生成草稿';
  } else if (!messagingAuthorization.inboundAutoSendAllowed) {
    blockedAutoReplyReason = blockedAutoReplyReason || `真实消息未发送：${messagingAuthorization.reasons.join('、')}`;
  }

  if (decision.decision === 'auto') {
    const guard = await guardOutbound(draft, { tenantId, customerId: customer.id, action });
    if (guard.allowed) {
      let sentMessages: string[] = [];
      let sentReceipts: Array<{ messageId: string; recipientId?: string; raw?: unknown }> = [];
      const delivery = await createCustomerManualTakeoverService(store).withAutoSendPermission({tenantId,customerId:customer.id,channel:'whatsapp'},()=>deliverAutoReply({ tenantId, to: message.waNumber, body: draft,
        recordAccepted: ({ message: body, receipt, index, total }) => {
          sentMessages.push(body); sentReceipts.push(receipt);
          addInteraction({ id: `${customer.id}-ai-${receipt.messageId}`, tenantId, customerId: customer.id,
            waNumber: message.waNumber, type: 'msg_out_ai', body, timestamp: Date.now(), autoSent: true,
            audit: { action, risk: decision.rule.risk, autonomy, evidence: context.evidence,
              providerMessageId: sentReceipts[index]?.messageId, providerRecipientId: receipt.recipientId,
              messageIndex: index, messageCount: total },
            meta: { provider: 'whatsapp', providerMessageId: receipt.messageId, providerRecipientId: receipt.recipientId },
          });
        },
      }, sendTenantWhatsAppTextWithReceipts));
      if (!delivery.complete) {
        const error = new Error(delivery.error);
        addInteraction({
          id: `${customer.id}-send-failed-${Date.now()}`,
          tenantId,
          customerId: customer.id,
          waNumber: message.waNumber,
          type: 'system',
          body: `AI 自动回复未完整确认，已停止自动发送；请先核对平台和已发送记录：${error instanceof Error ? error.message : 'WhatsApp send failed'}`,
          timestamp: Date.now(),
          audit: { action, risk: decision.rule.risk, autonomy, evidence: context.evidence, sendError: error instanceof Error ? error.message : String(error) },
        });
        upsertCustomer({
          tenantId,
          waNumber: message.waNumber,
          patch: {
            handlingMode: 'human_needed',
            handlingReason: '自动回复未完整确认，请先核对已发送记录，避免重复发送',
            pendingDraft: delivery.pendingDraft,
            blockedAutoReplyReason: delivery.reason,
            knowledgeMissStreak: nextMissStreak,
          },
        });
        await notifyCustomerHandoff({
          tenantId,
          customer: handoffCustomerContext(customer),
          message: message.body,
          decision: automationFailureHandoff(error instanceof Error ? error.message : 'WhatsApp send failed'),
        }).catch(() => undefined);
        return;
      }
      if (night.active) recordNightModeEvent({ tenantId, customerId: customer.id, kind: 'auto' });
      upsertCustomer({
        tenantId,
        waNumber: message.waNumber,
        patch: {
          handlingMode: 'ai_auto',
          handlingReason: decision.rule.desc,
          aiAutoCount: (customer.aiAutoCount ?? 0) + 1,
          pendingDraft: undefined,
          blockedAutoReplyReason: undefined,
          knowledgeMissStreak: 0,
        },
      });
      return;
    }
    addInteraction({
      id: `${customer.id}-guard-${Date.now()}`,
      tenantId,
      customerId: customer.id,
      waNumber: message.waNumber,
      type: 'system',
      body: `AI 想回复但涉及 ${guard.matchedRule || 'L4'}，已降级为待确认草稿。`,
      timestamp: Date.now(),
      audit: { action, risk: decision.rule.risk, autonomy, evidence: context.evidence, guardRule: guard.matchedRule },
    });
    upsertCustomer({
      tenantId,
      waNumber: message.waNumber,
      patch: {
        handlingMode: 'ai_draft',
        handlingReason: `AI 想回复但涉及${guard.matchedRule || '红线'}，需要你确认`,
        pendingDraft: draft,
        blockedAutoReplyReason: guard.matchedRule || '红线',
        knowledgeMissStreak: nextMissStreak,
      },
    });
    if (night.active) recordNightModeEvent({ tenantId, customerId: customer.id, kind: 'draft' });
    return;
  }

  if (night.active) recordNightModeEvent({ tenantId, customerId: customer.id, kind: 'draft' });
  upsertCustomer({
    tenantId,
    waNumber: message.waNumber,
    patch: {
      handlingMode: decision.decision === 'remind' ? 'human_needed' : 'ai_draft',
      handlingReason: decision.decision === 'remind' ? 'AI 已提醒你处理该客户' : `${decision.rule.desc}，AI 已生成草稿等待确认`,
      pendingDraft: decision.decision === 'draft' ? draft : undefined,
      blockedAutoReplyReason: blockedAutoReplyReason || undefined,
      knowledgeMissStreak: nextMissStreak,
    },
  });
}
