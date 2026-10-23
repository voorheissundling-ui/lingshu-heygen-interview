export type ObservedPresenterRole = 'sales_presenter' | 'presenter_action' | 'background' | 'none' | 'unknown';
/** Visual evidence only: narration over B-roll is not an on-screen speaker. */
export function recognizePresenterShot(slot: { title?: string; detail?: string; observedPresenterRole?: ObservedPresenterRole }): 'presenter' | 'motion' | 'material' {
  if (slot.observedPresenterRole === 'sales_presenter') return 'presenter';
  if (slot.observedPresenterRole === 'presenter_action') return 'motion';
  if (slot.observedPresenterRole === 'unknown') return 'material';
  if (slot.observedPresenterRole === 'background' || slot.observedPresenterRole === 'none') return 'material';
  const detail = String(slot.detail || '');
  const visual = detail.match(/画面[：:]([\s\S]*?)(?=镜头功能[：:]|口播[：:]|$)/)?.[1] || slot.title || detail.split('镜头功能：')[0];
  const person = /女性|男性|女人|男人|女士|男士|女主|男主|模特|销售|企业人物|主播|主持人|讲师|数字人|主角|主人公|presenter|sales/i.test(visual);
  const facing = /正面|面向镜头|面对镜头|直视镜头|镜头前|靠近镜头|出镜讲解|对镜口播|说话|嘴唇|口型|销售|主播|讲师|front.?facing|talking to camera|lip.?sync/i.test(visual);
  const speech = /口播[：:]\s*(?!无(?:\s|$))\S/.test(detail) || /对镜口播|销售.*口播|讲师.*口播|主播.*口播/i.test(visual);
  if (/(?:销售|女性|男性|主讲者|人物).{0,8}(?:背影|背对镜头)/.test(visual) && !/正面|面对镜头|对镜口播|嘴唇|口型/.test(visual)) return 'material';
  const action = /快速靠近|靠近镜头|转身|走向|敲门|左手举至镜头前|右手举至镜头前|明显动作|大幅手势|双臂.*(?:伸展|展开)|指向镜头|gesture|approach/i.test(visual);
  const visiblySpeaking = /对镜口播|出镜讲解|说话|嘴唇|口型|面对镜头.*讲解|talking to camera|lip.?sync/i.test(visual);
  if (person && facing && action && !visiblySpeaking) return 'motion';
  // Background workers, products and factory scenery must not veto a foreground speaker.
  if (person && facing && speech && !/^(?:画面[：:]\s*)?(?:工人背影|路人|人群|背景人物)/.test(visual.trim())) return 'presenter';
  if (person && facing && /快速靠近|靠近镜头|敲门|明显动作|大幅手势|双臂.*(?:伸展|展开)|指向镜头|gesture|approach/i.test(visual)) return 'motion';
  return 'material';
}

export type SalesPresenterEvidence = {
  title?: string; detail?: string; observedPresenterRole?: ObservedPresenterRole;
  personContinuityId?: string | null; salesPresenterConfirmed?: boolean; needsReview?: boolean;
};
/** A human/actor candidate is not proof of the recurring sales protagonist. */
export function salesPresenterRecognition(shot: SalesPresenterEvidence): 'confirmed' | 'candidate' | 'other' {
  if (shot.salesPresenterConfirmed === false) return 'other';
  if (shot.observedPresenterRole === 'background' || shot.observedPresenterRole === 'none') return 'other';
  if (shot.needsReview === true) return shot.observedPresenterRole === 'sales_presenter' || shot.observedPresenterRole === 'presenter_action' ? 'candidate' : 'other';
  if (shot.salesPresenterConfirmed === true) {
    if (!shot.personContinuityId?.trim()) return shot.observedPresenterRole === 'sales_presenter' || shot.observedPresenterRole === 'presenter_action' ? 'candidate' : 'other';
    return shot.observedPresenterRole === 'sales_presenter' || shot.observedPresenterRole === 'presenter_action' ? 'confirmed' : 'other';
  }
  if (!shot.needsReview && shot.observedPresenterRole === 'sales_presenter' && shot.personContinuityId?.trim()) return 'confirmed';
  if (shot.observedPresenterRole === 'sales_presenter' || shot.observedPresenterRole === 'presenter_action') return 'candidate';
  return recognizePresenterShot({ ...shot, observedPresenterRole: undefined }) !== 'material' ? 'candidate' : 'other';
}
export function confirmedSalesPresenterRoute(shot: SalesPresenterEvidence): 'presenter' | 'motion' | 'material' {
  if (salesPresenterRecognition(shot) !== 'confirmed') return 'material';
  const route = recognizePresenterShot({ ...shot, observedPresenterRole: shot.observedPresenterRole === 'unknown' ? undefined : shot.observedPresenterRole });
  return route === 'motion' ? 'motion' : 'presenter';
}

/**
 * Background classifier refreshes may add evidence, but must not silently
 * downgrade a sales presenter that is already confirmed in the saved draft.
 * Removing a confirmed person changes the paid production route and therefore
 * requires an explicit user review instead of an asynchronous page refresh.
 */
export function mergeAutomatedPresenterReviewEvidence(
  current: SalesPresenterEvidence,
  incoming: Pick<SalesPresenterEvidence, 'observedPresenterRole' | 'personContinuityId' | 'needsReview'>,
): SalesPresenterEvidence {
  const reviewed: SalesPresenterEvidence = {
    observedPresenterRole: incoming.observedPresenterRole,
    personContinuityId: incoming.personContinuityId,
    needsReview: incoming.needsReview === true,
    salesPresenterConfirmed: incoming.observedPresenterRole === 'sales_presenter' && incoming.needsReview !== true,
  };
  if (salesPresenterRecognition(current) === 'confirmed' && salesPresenterRecognition(reviewed) !== 'confirmed') {
    return current;
  }
  return reviewed;
}

/** Display the observed sales role even while cross-shot identity is pending.
 * This label must never grant admission to a generation provider. */
export function isSalesPresenterLabel(shot: SalesPresenterEvidence): boolean {
  if (shot.salesPresenterConfirmed === false || (shot.needsReview && !shot.salesPresenterConfirmed) || shot.observedPresenterRole === 'background' || shot.observedPresenterRole === 'none') return false;
  if (shot.salesPresenterConfirmed === true || shot.observedPresenterRole === 'sales_presenter') return true;
  const visual = String(shot.detail || shot.title || '').split(/口播[：:]/)[0];
  return /销售人员口播|销售.*(?:对镜口播|出镜讲解)|(?:讲师|主播|主持人).*(?:对镜口播|出镜讲解|面对镜头.*讲解)/.test(visual)
    && !/路人|D\s*to\s*C|素人|背景人物/i.test(visual);
}
