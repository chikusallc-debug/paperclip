/**
 * Coarse taxonomy of KB documents. Factory profiles may use any string,
 * but these values are the first-class vocabulary agents should prefer.
 */
export type KnowledgeBaseDocumentKind =
  | "character"
  | "location"
  | "timeline"
  | "style_guide"
  | "brand_voice"
  | "series_bible"
  | "plot_outline"
  | "custom";

export type KnowledgeBaseDocumentFormat = "markdown" | "html" | "plain";

export interface KnowledgeBaseDocument {
  id: string;
  companyId: string;
  projectId: string | null;
  path: string;
  title: string;
  kind: KnowledgeBaseDocumentKind | string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  format: KnowledgeBaseDocumentFormat | string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Rules that define how a context pack resolves to a set of KB docs.
 * V1 intentionally narrow: deterministic, composable, no semantic
 * retrieval. Semantic search can be added as a pack rule later
 * without breaking existing packs.
 */
export interface ContextPackRules {
  includePaths?: string[];
  includeTagsAny?: string[];
  includeKinds?: string[];
  /** Soft cap on total docs after union + dedup, applied before sort. */
  maxDocs?: number;
}

export interface ContextPack {
  id: string;
  companyId: string;
  projectId: string | null;
  name: string;
  description: string | null;
  rules: ContextPackRules;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Document embedded in a context pack resolution. Body is inlined so
 * agents can consume the pack as a single prompt fragment without a
 * second fetch.
 */
export interface ResolvedContextPackDocument {
  id: string;
  path: string;
  title: string;
  kind: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  format: string;
  updatedAt: Date;
}

export interface ContextPackResolution {
  packId: string | null;
  name: string;
  projectId: string | null;
  rulesApplied: ContextPackRules;
  documents: ResolvedContextPackDocument[];
  /** Total documents matched before maxDocs capping, for observability. */
  totalMatched: number;
  truncated: boolean;
  resolvedAt: Date;
}
