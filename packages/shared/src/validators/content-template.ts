import { z } from "zod";
import {
  contentWorkProductKindSchema,
  contentWorkProductStatusSchema,
} from "./content-work-product.js";

const NAME_MAX = 200;
const TITLE_TEMPLATE_MAX = 500;
const SLUG_TEMPLATE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const OUTLINE_MAX = 200_000;
const TAG_MAX = 64;
const TYPE_MAX = 100;

export const contentTemplateNameSchema = z
  .string()
  .min(1)
  .max(NAME_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "name must be lowercase kebab-case");

export const createContentTemplateSchema = z.object({
  name: contentTemplateNameSchema,
  description: z.string().max(DESCRIPTION_MAX).optional().nullable(),
  type: z.string().min(1).max(TYPE_MAX),
  kind: contentWorkProductKindSchema.optional().default("content"),
  titleTemplate: z.string().min(1).max(TITLE_TEMPLATE_MAX),
  slugTemplate: z.string().min(1).max(SLUG_TEMPLATE_MAX).optional().nullable(),
  defaultStatus: contentWorkProductStatusSchema.optional().default("draft"),
  defaultTags: z.array(z.string().min(1).max(TAG_MAX)).optional().default([]),
  defaultMetadata: z.record(z.unknown()).optional().default({}),
  defaultContextPackIds: z.array(z.string().uuid()).optional().default([]),
  outlineBody: z.string().max(OUTLINE_MAX).optional().nullable(),
  passCriteria: z.record(z.unknown()).optional().default({}),
});

export type CreateContentTemplateInput = z.infer<typeof createContentTemplateSchema>;

export const updateContentTemplateSchema = z
  .object({
    name: contentTemplateNameSchema.optional(),
    description: z.string().max(DESCRIPTION_MAX).optional().nullable(),
    type: z.string().min(1).max(TYPE_MAX).optional(),
    kind: contentWorkProductKindSchema.optional(),
    titleTemplate: z.string().min(1).max(TITLE_TEMPLATE_MAX).optional(),
    slugTemplate: z.string().min(1).max(SLUG_TEMPLATE_MAX).optional().nullable(),
    defaultStatus: contentWorkProductStatusSchema.optional(),
    defaultTags: z.array(z.string().min(1).max(TAG_MAX)).optional(),
    defaultMetadata: z.record(z.unknown()).optional(),
    defaultContextPackIds: z.array(z.string().uuid()).optional(),
    outlineBody: z.string().max(OUTLINE_MAX).optional().nullable(),
    passCriteria: z.record(z.unknown()).optional(),
  })
  .strict();

export type UpdateContentTemplateInput = z.infer<typeof updateContentTemplateSchema>;

/**
 * Shape for POST /api/content-templates/:id/instantiate.
 *
 * - `variables` is the dict plugged into {{...}} placeholders in
 *   `titleTemplate`, `slugTemplate`, and `outlineBody`.
 * - `overrides` lets the caller tweak the resulting work product
 *   directly (e.g. attach to a project/issue, add extra tags) without
 *   editing the template.
 */
export const instantiateContentTemplateSchema = z.object({
  variables: z.record(z.union([z.string(), z.number()])).optional().default({}),
  overrides: z
    .object({
      projectId: z.string().uuid().optional().nullable(),
      issueId: z.string().uuid().optional().nullable(),
      title: z.string().min(1).max(TITLE_TEMPLATE_MAX).optional(),
      slug: z
        .string()
        .min(1)
        .max(SLUG_TEMPLATE_MAX)
        .regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase kebab-case")
        .optional()
        .nullable(),
      status: contentWorkProductStatusSchema.optional(),
      tags: z.array(z.string().min(1).max(TAG_MAX)).optional(),
      metadata: z.record(z.unknown()).optional(),
      extraContextPackIds: z.array(z.string().uuid()).optional(),
    })
    .strict()
    .optional()
    .default({}),
});

export type InstantiateContentTemplateInput = z.infer<typeof instantiateContentTemplateSchema>;
