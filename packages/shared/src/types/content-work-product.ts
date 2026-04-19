/**
 * Canonical workflow states for a content work product. Unknown values are
 * allowed so domain profiles can add states (e.g. "continuity_passed" for
 * novels, "layout_ready" for PDF courses) without a schema migration.
 */
export type ContentWorkProductStatus =
  | "draft"
  | "in_review"
  | "final"
  | "published"
  | "archived";

/**
 * "content" = generated deliverable (chapter, landing page, sales copy).
 * "reference" = enduring input (style guide, series bible, canon doc).
 */
export type ContentWorkProductKind = "content" | "reference";

export type ContentWorkProductFormat = "markdown" | "html" | "plain";

export interface ContentWorkProductVersionSummary {
  id: string;
  versionNumber: number;
  changeSummary: string | null;
  statusAtCreation: string;
  format: ContentWorkProductFormat | string;
  authoredByAgentId: string | null;
  authoredByUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
}

export interface ContentWorkProductVersion extends ContentWorkProductVersionSummary {
  companyId: string;
  workProductId: string;
  body: string;
  parentVersionId: string | null;
  metadata: Record<string, unknown>;
}

export interface ContentWorkProduct {
  id: string;
  companyId: string;
  projectId: string | null;
  issueId: string | null;
  type: string;
  kind: ContentWorkProductKind | string;
  title: string;
  slug: string | null;
  status: ContentWorkProductStatus | string;
  tags: string[];
  metadata: Record<string, unknown>;
  latestVersionId: string | null;
  latestVersionNumber: number;
  publishedVersionId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Return shape for the "fat" detail endpoint — work product plus the
 * latest version body inlined, which is what an agent or UI typically wants.
 */
export interface ContentWorkProductWithLatest extends ContentWorkProduct {
  latestVersion: ContentWorkProductVersion | null;
}
