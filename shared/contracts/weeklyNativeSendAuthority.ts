export interface WeeklyNativeSendAuthority {
 tenantId:string;programId:string;packageId:string;packageVersion:number;runId:string;goalId:string;planId:string;
 actorUserId:string;batchId:string;batchVersion:number;batchHash:string;itemId:string;itemHash:string;memberId:string;customerId:string;
 channel:'messenger'|'instagram';accountId:string;nativeAccountId:string;recipientId:string;conversationId:string;selectionHash:string;
}
