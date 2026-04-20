import { z } from "zod";

const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;

export const publishingTargetNameSchema = z
  .string()
  .min(1)
  .max(NAME_MAX)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "name must be lowercase kebab-case");

/**
 * Webhook target config. The URL must parse; scheme validation
 * happens in the service layer where we know the deployment mode
 * (local_trusted can relax https-only). Keeping this validator
 * deployment-agnostic so the shared schema stays portable.
 */
export const webhookTargetConfigSchema = z.object({
  url: z.string().url(),
  method: z.enum(["POST", "PUT"]).optional().default("POST"),
  headers: z.record(z.string()).optional(),
  authHeader: z.string().min(1).max(100).optional(),
  authScheme: z.string().max(50).optional(),
  hmacHeader: z.string().min(1).max(100).optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
});

export const publishingTargetTypeSchema = z.enum(["webhook"]);

export const createPublishingTargetSchema = z
  .object({
    name: publishingTargetNameSchema,
    description: z.string().max(DESCRIPTION_MAX).optional().nullable(),
    type: publishingTargetTypeSchema,
    config: webhookTargetConfigSchema,
    secretId: z.string().uuid().optional().nullable(),
    enabled: z.boolean().optional().default(true),
  })
  .strict();

export type CreatePublishingTargetInput = z.infer<typeof createPublishingTargetSchema>;

export const updatePublishingTargetSchema = z
  .object({
    name: publishingTargetNameSchema.optional(),
    description: z.string().max(DESCRIPTION_MAX).optional().nullable(),
    config: webhookTargetConfigSchema.optional(),
    secretId: z.string().uuid().optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type UpdatePublishingTargetInput = z.infer<typeof updatePublishingTargetSchema>;

export const publishWorkProductSchema = z
  .object({
    /** Defaults to the work product's published version (if any) else latest. */
    versionNumber: z.number().int().positive().optional(),
  })
  .strict();

export type PublishWorkProductInput = z.infer<typeof publishWorkProductSchema>;
