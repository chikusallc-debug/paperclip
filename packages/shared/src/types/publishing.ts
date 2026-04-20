/**
 * Publishing target types. V1 supports only "webhook" — generic
 * authenticated HTTPS POST. Future providers (github, r2, substack)
 * slot into the same registry.
 */
export type PublishingTargetType = "webhook" | "github";

export interface GithubTargetConfig {
  owner: string;
  repo: string;
  branch?: string;
  /** Path template; supports {{slug}}, {{title}}, {{type}}, {{version}}. */
  path: string;
  /** Commit message template; supports the same vars. */
  message?: string;
  committerName?: string;
  committerEmail?: string;
  /** Override for self-hosted GitHub Enterprise. */
  apiBaseUrl?: string;
  timeoutMs?: number;
}

export interface WebhookTargetConfig {
  /** Destination URL. HTTPS required unless explicitly opted out. */
  url: string;
  /** Defaults to POST. */
  method?: "POST" | "PUT";
  /** Extra request headers (values stored here are NOT secrets). */
  headers?: Record<string, string>;
  /** Header name to attach the resolved secret to. Default "Authorization". */
  authHeader?: string;
  /** Prepended to the secret value. Default "Bearer ". */
  authScheme?: string;
  /** When set, HMAC-SHA256(body) hex digest is sent in this header. */
  hmacHeader?: string;
  /** Optional per-target timeout in ms. Default 30 000; max 60 000. */
  timeoutMs?: number;
}

export interface PublishingTarget {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  type: PublishingTargetType | string;
  config: Record<string, unknown>;
  secretId: string | null;
  enabled: boolean;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PublishAttemptStatus = "pending" | "success" | "failed";

export interface PublishAttempt {
  id: string;
  companyId: string;
  workProductId: string;
  workProductVersionId: string;
  targetId: string;
  status: PublishAttemptStatus | string;
  httpStatus: number | null;
  durationMs: number | null;
  requestSummary: Record<string, unknown> | null;
  responseSummary: Record<string, unknown> | null;
  errorMessage: string | null;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  startedAt: Date;
  completedAt: Date | null;
}
