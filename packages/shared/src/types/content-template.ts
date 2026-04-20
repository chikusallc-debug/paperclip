import type { ContentWorkProductKind } from "./content-work-product.js";

/**
 * Reusable blueprint for creating content work products. Templates
 * capture the type, outline, default packs, and pass criteria so a
 * factory can spin up "chapter N" or "course section N" without
 * operators re-entering scaffolding each time.
 */
export interface ContentTemplate {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  type: string;
  kind: ContentWorkProductKind | string;
  titleTemplate: string;
  slugTemplate: string | null;
  defaultStatus: string;
  defaultTags: string[];
  defaultMetadata: Record<string, unknown>;
  defaultContextPackIds: string[];
  outlineBody: string | null;
  passCriteria: Record<string, unknown>;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
