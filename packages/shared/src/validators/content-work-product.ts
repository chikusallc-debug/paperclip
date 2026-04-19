import { z } from "zod";

const TITLE_MAX = 500;
const SLUG_MAX = 200;
const TYPE_MAX = 100;
const CHANGE_SUMMARY_MAX = 2000;
const BODY_MAX = 5_000_000;

export const contentWorkProductKindSchema = z.enum(["content", "reference"]);

/**
 * Canonical statuses. The API accepts custom values too, so domain profiles
 * ("continuity_passed", "layout_ready") can extend without a new migration
 * — validated here with a regex to keep the state machine disciplined.
 */
export const contentWorkProductStatusSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, "status must be lowercase snake_case");

export const contentWorkProductFormatSchema = z
  .enum(["markdown", "html", "plain"])
  .default("markdown");

export const contentWorkProductSlugSchema = z
  .string()
  .min(1)
  .max(SLUG_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase kebab-case");

export const createContentWorkProductSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
  issueId: z.string().uuid().optional().nullable(),
  type: z.string().min(1).max(TYPE_MAX),
  kind: contentWorkProductKindSchema.optional().default("content"),
  title: z.string().min(1).max(TITLE_MAX),
  slug: contentWorkProductSlugSchema.optional().nullable(),
  status: contentWorkProductStatusSchema.optional().default("draft"),
  tags: z.array(z.string().min(1).max(64)).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  /**
   * If provided, a first version is created alongside the work product.
   * Otherwise the work product starts with no versions and
   * latestVersionNumber=0.
   */
  initialBody: z.string().max(BODY_MAX).optional(),
  initialFormat: contentWorkProductFormatSchema.optional(),
  initialChangeSummary: z.string().max(CHANGE_SUMMARY_MAX).optional(),
});

export type CreateContentWorkProductInput = z.infer<typeof createContentWorkProductSchema>;

export const updateContentWorkProductSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX).optional(),
    slug: contentWorkProductSlugSchema.optional().nullable(),
    status: contentWorkProductStatusSchema.optional(),
    type: z.string().min(1).max(TYPE_MAX).optional(),
    kind: contentWorkProductKindSchema.optional(),
    tags: z.array(z.string().min(1).max(64)).optional(),
    metadata: z.record(z.unknown()).optional(),
    projectId: z.string().uuid().optional().nullable(),
    issueId: z.string().uuid().optional().nullable(),
  })
  .strict();

export type UpdateContentWorkProductInput = z.infer<typeof updateContentWorkProductSchema>;

export const createContentWorkProductVersionSchema = z.object({
  body: z.string().min(0).max(BODY_MAX),
  format: contentWorkProductFormatSchema.optional(),
  changeSummary: z.string().max(CHANGE_SUMMARY_MAX).optional().nullable(),
  parentVersionId: z.string().uuid().optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
  /**
   * Optional new workflow status to transition the work product into when
   * this version lands (e.g. "in_review" after an edit pass).
   */
  advanceStatusTo: contentWorkProductStatusSchema.optional(),
});

export type CreateContentWorkProductVersionInput = z.infer<typeof createContentWorkProductVersionSchema>;

export const publishContentWorkProductSchema = z.object({
  /**
   * Which version to mark as the published one. Defaults to the latest.
   */
  versionNumber: z.number().int().positive().optional(),
});

export type PublishContentWorkProductInput = z.infer<typeof publishContentWorkProductSchema>;
