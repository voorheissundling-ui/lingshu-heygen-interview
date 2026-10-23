export interface CustomerFeedbackTopicCandidate {
 schemaVersion:'customer-feedback-topic.v1';id:string;version:1;tenantId:string;programId:string;
 source:{packageId:string;packageVersion:number;weekStart:string;weekEnd:string;handoffId:string;handoffVersion:number;handoffBaseHash:string;feedbackEventId:string;feedbackEventHash:string;interactionId:string;interactionHash:string;customerId:string;timestamp:number;body:string;excerptStart:number;excerptEnd:number;question:string;customerRelationship:'new_inquiry'|'existing_customer'|'unknown'};
 topicAngle:string;attributionConclusion:'not_measured';createdBy:string;createdAt:string;recordHash:string;
}
export interface CustomerFeedbackTopicConfirmation {
 schemaVersion:'customer-feedback-topic-confirmation.v1';id:string;version:1;tenantId:string;programId:string;
 candidateRef:{id:string;version:1;recordHash:string};target:{packageId:string;packageVersion:number;publicationTaskId:string;weekStart:string;weekEnd:string};
 status:'pending_next_revision';confirmedBy:string;confirmedAt:string;recordHash:string;
}
