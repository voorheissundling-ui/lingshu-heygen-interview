export type WeeklySalesStatus = 'awaiting_claim' | 'in_progress' | 'awaiting_feedback' | 'handled' | 'needs_information';
export interface WeeklySalesHandoff {
  id: string; tenantId: string; programId: string; packageId: string; packageVersion: number;
  channel?: 'whatsapp'|'messenger'|'instagram'; runId: string; memberId: string; customerId: string; sourceInteractionId: string;
  sourceKind: 'new_inquiry' | 'existing_customer' | 'existing_contact'; sourceEvidence: Record<string, unknown>;
  ownerUserId: string; createdBy: string; claimDueAt: string; feedbackDueAt: string;
  approvedBatchId: string; approvedBatchVersion: number; approvedContentHash: string;
  status: WeeklySalesStatus; version: number; claimedAt: string | null;
  feedback: { result: string; evidenceInteractionIds: string[]; nextStep: string; nextDueAt: string; recordedAt: string } | null;
}
export function weeklySalesOverdue(item: WeeklySalesHandoff, now: number): 'claim' | 'feedback' | 'information' | null {
  if (item.status === 'awaiting_claim' && Date.parse(item.claimDueAt) < now) return 'claim';
  if (['in_progress', 'awaiting_feedback'].includes(item.status) && Date.parse(item.feedbackDueAt) < now) return 'feedback';
  if(item.status==='needs_information'&&item.feedback&&Date.parse(item.feedback.nextDueAt)<now)return 'information';
  return null;
}

export interface WeeklySalesSource { channel?:'whatsapp'|'messenger'|'instagram'; runId:string; memberId:string; customerId:string; customerName:string; sourceInteractionId:string; body:string; timestamp:number; sourceKind:'new_inquiry'|'existing_customer'|'existing_contact'; }

/** Reject partial or inconsistent handoffs before they become actionable cards. */
export function isWeeklySalesHandoff(value:unknown):value is WeeklySalesHandoff {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const i=value as WeeklySalesHandoff, nonempty=(v:unknown)=>typeof v==='string'&&v.trim().length>0, instant=(v:unknown)=>typeof v==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
 if(!['id','tenantId','programId','packageId','runId','memberId','customerId','sourceInteractionId','ownerUserId','createdBy','approvedBatchId','approvedContentHash'].every(k=>nonempty(i[k as keyof WeeklySalesHandoff]))||!['packageVersion','version','approvedBatchVersion'].every(k=>Number.isSafeInteger(i[k as keyof WeeklySalesHandoff])&&Number(i[k as keyof WeeklySalesHandoff])>0)||!['new_inquiry','existing_customer','existing_contact'].includes(i.sourceKind)||!['awaiting_claim','in_progress','awaiting_feedback','handled','needs_information'].includes(i.status)||i.channel!==undefined&&!['whatsapp','messenger','instagram'].includes(i.channel)||!instant(i.claimDueAt)||!instant(i.feedbackDueAt)||Date.parse(i.feedbackDueAt)<Date.parse(i.claimDueAt))return false;
 if(!i.sourceEvidence||typeof i.sourceEvidence!=='object'||Array.isArray(i.sourceEvidence)||!nonempty(i.sourceEvidence.body)||i.sourceEvidence.interactionId!==i.sourceInteractionId||typeof i.sourceEvidence.timestamp!=='number'||!Number.isFinite(i.sourceEvidence.timestamp))return false;
 if(i.claimedAt!==null&&!instant(i.claimedAt)||i.status==='awaiting_claim'&&i.claimedAt!==null||i.status!=='awaiting_claim'&&i.claimedAt===null)return false;
 if(i.feedback!==null){const f=i.feedback;if(!f||typeof f!=='object'||!nonempty(f.result)||!nonempty(f.nextStep)||!instant(f.nextDueAt)||!instant(f.recordedAt)||!Array.isArray(f.evidenceInteractionIds)||!f.evidenceInteractionIds.length||!f.evidenceInteractionIds.every(nonempty)||new Set(f.evidenceInteractionIds).size!==f.evidenceInteractionIds.length)return false;}
 return ['handled','needs_information'].includes(i.status)?i.feedback!==null:i.feedback===null;
}
