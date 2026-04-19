import { z } from "zod";

const PATH_MAX = 500;
const TITLE_MAX = 500;
const BODY_MAX = 5_000_000;
const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const TAG_MAX = 64;

export const knowledgeBaseDocumentFormatSchema = z.enum(["markdown", "html", "plain"]).default("markdown");

/**
 * Enforces a forward-slash-delimited POSIX-style path without traversal,
 * absolute roots, or backslashes. Agents are expected to use stable,
 * typable paths like "characters/elena-rostova.md". Deliberately
 * permissive on file extensions so non-Markdown docs fit the same
 * namespace without a special case.
 */
export const knowledgeBaseDocumentPathSchema = z
  .string()
  .min(1)
  .max(PATH_MAX)
  .regex(
    /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?:[A-Za-z0-9_.-]+)(?:\/[A-Za-z0-9_.-]+)*$/,
    "path must be POSIX-relative using [A-Za-z0-9_.-] segments",
  );

export const knowledgeBaseDocumentKindSchema = z.string().min(1).max(64).regex(
  /^[a-z][a-z0-9_]*$/,
  "kind must be lowercase snake_case",
);

export const createKnowledgeBaseDocumentSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  path: knowledgeBaseDocumentPathSchema,
  title: z.string().min(1).max(TITLE_MAX),
  kind: knowledgeBaseDocumentKindSchema.optional().default("custom"),
  tags: z.array(z.string().min(1).max(TAG_MAX)).optional().default([]),
  frontmatter: z.record(z.unknown()).optional().default({}),
  body: z.string().max(BODY_MAX),
  format: knowledgeBaseDocumentFormatSchema.optional(),
});

export type CreateKnowledgeBaseDocumentInput = z.infer<
  typeof createKnowledgeBaseDocumentSchema
>;

export const updateKnowledgeBaseDocumentSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX).optional(),
    kind: knowledgeBaseDocumentKindSchema.optional(),
    tags: z.array(z.string().min(1).max(TAG_MAX)).optional(),
    frontmatter: z.record(z.unknown()).optional(),
    body: z.string().max(BODY_MAX).optional(),
    format: knowledgeBaseDocumentFormatSchema.optional(),
    path: knowledgeBaseDocumentPathSchema.optional(),
    projectId: z.string().uuid().optional().nullable(),
  })
  .strict();

export type UpdateKnowledgeBaseDocumentInput = z.infer<
  typeof updateKnowledgeBaseDocumentSchema
>;

/**
 * Idempotent upsert-by-path (for agents that treat the KB as a file
 * tree). Callers POST the body to /knowledge-base-documents/by-path and
 * the service inserts or updates by (company, project, path).
 */
export const upsertKnowledgeBaseDocumentSchema = createKnowledgeBaseDocumentSchema;
export type UpsertKnowledgeBaseDocumentInput = CreateKnowledgeBaseDocumentInput;

export const contextPackRulesSchema = z.object({
  includePaths: z.array(knowledgeBaseDocumentPathSchema).optional(),
  includeTagsAny: z.array(z.string().min(1).max(TAG_MAX)).optional(),
  includeKinds: z.array(knowledgeBaseDocumentKindSchema).optional(),
  maxDocs: z.number().int().positive().max(1000).optional(),
});

export type ContextPackRulesInput = z.infer<typeof contextPackRulesSchema>;

export const contextPackNameSchema = z
  .string()
  .min(1)
  .max(NAME_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "name must be lowercase kebab-case");

export const createContextPackSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  name: contextPackNameSchema,
  description: z.string().max(DESCRIPTION_MAX).optional().nullable(),
  rules: contextPackRulesSchema.optional().default({}),
});

export type CreateContextPackInput = z.infer<typeof createContextPackSchema>;

export const updateContextPackSchema = z
  .object({
    name: contextPackNameSchema.optional(),
    description: z.string().max(DESCRIPTION_MAX).optional().nullable(),
    rules: contextPackRulesSchema.optional(),
    projectId: z.string().uuid().optional().nullable(),
  })
  .strict();

export type UpdateContextPackInput = z.infer<typeof updateContextPackSchema>;

/**
 * At resolution time the caller may override or extend pack rules.
 * Useful for per-run ad-hoc additions (e.g. include a just-edited
 * character card without editing the pack).
 */
export const resolveContextPackSchema = z.object({
  overrideRules: contextPackRulesSchema.optional(),
});

export type ResolveContextPackInput = z.infer<typeof resolveContextPackSchema>;
