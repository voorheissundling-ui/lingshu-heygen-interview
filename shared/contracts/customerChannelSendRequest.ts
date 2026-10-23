export type CustomerMessageChannel='whatsapp'|'messenger'|'instagram';
/** Provider request identity is channel specific. Missing provider identity remains unknown. */
export interface CustomerChannelSendRequest {
 requestId:string;channel:'messenger'|'instagram';tenantId:string;actorUserId:string;customerId:string;accountId:string;
 bodyHash:string;accountAuthorityHash:string;recipientHash:string;recipientMasked:string;
 deliveryStatus:'unverified'|'sent'|'delivered'|'read'|'failed';status:'sending'|'accepted'|'unknown';providerMessageId:string|null;createdAt:string;settledAt:string|null;
 weeklyAuthorityHash?:string;weeklySource?:{programId:string;packageId:string;packageVersion:number;runId:string;batchId:string;batchVersion:number;itemId:string;itemHash:string;selectionHash:string};
 recoveryGap:'provider_identity_gap'|'provider_response_save_gap'|null;
 historyWritebackPending:boolean;
}
export interface CustomerChannelSendReceipt {requestId:string;acceptedAt:string;messageId:string;recipientId:string;raw:Record<string,unknown>}

export interface CustomerChannelOutboxContext {tenantId:string;actorUserId:string;customerId:string;channel:'messenger'|'instagram';accountId:string;accountAuthorityHash:string}

export interface SignedChannelMessageReceipt {tenantId:string;channel:'messenger'|'instagram';nativeAccountId:string;recipientId:string;providerMessageId:string;status:'sent'|'delivered'|'read'|'failed';occurredAt:string;eventKind:'echo'|'delivery'|'read';eventHash:string;signedBodyHash:string;verifiedSignature:true;body?:string}
