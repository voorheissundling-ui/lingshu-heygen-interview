import type {VersionedSocialRef} from './socialProgram.js';

export interface WeeklyCreativeRepairAuditReceipt {
  schemaVersion:'weekly-creative-repair-audit.v1';
  version:1;
  tenantId:string;
  programId:string;
  packageId:string;
  packageVersion:number;
  caseId:string;
  caseRequestHash:string;
  executionRecordHash:string;
  childTaskId:string;
  childRunId:string;
  childJobId:string;
  childArtifactRef:VersionedSocialRef;
  childArtifactHash:string;
  sceneCacheHash:string;
  g5ReviewId:string;
  g5ReviewHash:string;
  g5ReceiptId:string;
  g5ReceiptHash:string;
  verifiedBy:string;
  verifiedAt:string;
  recordHash:string;
}
