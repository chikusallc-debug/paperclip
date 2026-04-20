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

export const publishingTargetTypeSchema = z.enum(["webhook", "github"]);

/**
 * GitHub Contents API target. Requires a secretId holding a PAT or
 * installation token — the provider refuses to run without one.
 */
export const githubTargetConfigSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  branch: z.string().min(1).max(200).optional(),
  /** Path template; supports {{slug}}, {{title}}, {{type}}, {{version}}. */
  path: z.string().min(1).max(500),
  message: z.string().min(1).max(500).optional(),
  committerName: z.string().min(1).max(100).optional(),
  committerEmail: z.string().email().optional(),
  apiBaseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
});

/**
 * The config union is discriminated on the target's `type`. Zod
 * v3's `discriminatedUnion` needs both branches to share the
 * discriminator literal — since our discriminator lives on the
 * PARENT (not inside config), we keep config as a tagged union
 * and validate it manually in the superRefine below.
 */
export const createPublishingTargetSchema = z
  .object({
    name: publishingTargetNameSchema,
    description: z.string().max(DESCRIPTION_MAX).optional().nullable(),
    type: publishingTargetTypeSchema,
    config: z.unknown(),
    secretId: z.string().uuid().optional().nullable(),
    enabled: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((input, ctx) => {
    const check =
      input.type === "github" ? githubTargetConfigSchema : webhookTargetConfigSchema;
    const result = check.safeParse(input.config);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ["config", ...(issue.path ?? [])] });
      }
    }
  });

export type CreatePublishingTargetInput = z.infer<typeof createPublishingTargetSchema>;

/**
 * Update schema is untyped on config (the target's type was set at
 * creation and can't change). The service layer re-validates the
 * config against the existing target's type before persisting.
 */
export const updatePublishingTargetSchema = z
  .object({
    name: publishingTargetNameSchema.optional(),
    description: z.string().max(DESCRIPTION_MAX).optional().nullable(),
    config: z.record(z.unknown()).optional(),
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
