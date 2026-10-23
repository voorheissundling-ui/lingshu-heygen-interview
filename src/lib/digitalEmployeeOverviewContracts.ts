export type DataAvailability = "available" | "pending" | "unavailable";

export interface BusinessMetric {
  value: number | null;
  status: DataAvailability;
  source: string;
  note?: string;
}

export interface BusinessReadinessItem {
  key: "enterprise" | "products" | "social_accounts" | "viral_library" | "content_projects" | "customers" | "automation";
  label: string;
  status: "ready" | "incomplete" | "empty";
  count: number | null;
  page: string;
  note: string;
}

export interface SnapshotTaskReference {
  id: string;
  title: string;
  status: string;
  taskId?: string;
  runId?: string;
  businessRef?: Record<string, unknown>;
  occurredAt?: string;
}

export interface DigitalEmployeePublishingReadiness {
  required: boolean;
  ready: boolean;
  status: "not_required" | "ready" | "action_required" | "unavailable";
  targetPlatforms: Array<"facebook" | "instagram" | "tiktok" | "youtube">;
  connectedPlatforms: Array<"facebook" | "instagram" | "tiktok" | "youtube">;
  missingOAuthPlatforms: Array<"facebook" | "instagram" | "tiktok" | "youtube">;
  missingAccountPlatforms: Array<"facebook" | "instagram" | "tiktok" | "youtube">;
  summary: string;
  actionPage: "accountManagement";
}
