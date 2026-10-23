/** Current readonly observation; original cancellation effects remain immutable history. */
export interface WeeklyCancellationSettlement {resourceType:string;resourceId:string;status:'published'|'failed'|'unknown'|'unverified';resolvedAt:string|null;gap:string|null}
