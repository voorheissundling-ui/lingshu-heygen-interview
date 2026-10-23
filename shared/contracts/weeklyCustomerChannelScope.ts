export type WeeklyCustomerChannel='whatsapp'|'messenger'|'instagram';
export interface WeeklyCustomerChannelScopeIdentity {tenantId:string;runId:string;goalId:string;programId:string;packageId:string;packageVersion:number;route:'cold_start'|'account_repair';weekStart:string;weekEnd:string}
export interface WeeklyCustomerChannelSelectionReceipt {
 selectionId:string;version:1;actorUserId:string;createdAt:string;classification:'new_inquiry'|'existing_contact';reason:string;
 scope:WeeklyCustomerChannelScopeIdentity;channel:WeeklyCustomerChannel;accountId:string;nativeAccountId:string;customerId:string;recipientId:string;conversationId:string;inboundMessageId:string;inboundAt:string;accountHash:string;inboundHash:string;evidenceHash:string;relationshipEvidenceHash:string;recordHash:string;
}
export interface WeeklyCustomerChannelScopeView {
 scope:WeeklyCustomerChannelScopeIdentity;
 accounts:Array<{accountId:string;channel:WeeklyCustomerChannel;nativeAccountId:string;status:string}>;
 conversations:Array<{channel:WeeklyCustomerChannel;accountId:string;customerId:string;conversationId:string;recipientId:string;inboundMessages:Array<{messageId:string;body:string;occurredAt:string;recordHash:string}>;relationship:'existing_contact'|'unknown'}>;
 selections:WeeklyCustomerChannelSelectionReceipt[];gaps:Array<{channel:WeeklyCustomerChannel;code:string}>;
}
export interface ConfirmWeeklyCustomerChannelScope {runId:string;packageId:string;packageVersion:number;channel:WeeklyCustomerChannel;accountId:string;customerId:string;inboundMessageId:string;classification:'new_inquiry'|'existing_contact';reason:string}
