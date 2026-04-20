import type { Db } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import {
  contentWorkProductService,
} from "./content-work-products.js";
import { knowledgeBaseService } from "./knowledge-base.js";

/**
 * Bible-update workflow
 *
 * A "Bible update" is a proposed change to one KB document (a
 * character card, a timeline slice, the series bible itself)
 * packaged as a content work product so it can go through the
 * normal draft → in_review → final authoring flow before landing.
 *
 * Shape of a proposal:
 *   type:  "bible_update_proposal"
 *   kind:  "reference"
 *   metadata: {
 *     targetKbPath: "characters/elena-rostova.md",  // required
 *     targetKbProjectId: "<uuid>" | null,            // optional (null = company-scope)
 *     applyMode: "replace" | "append" | "prepend",   // default "replace"
 *   }
 *
 * A lore-keeper agent authors the proposal like any other work
 * product (drafts → in_review). When a board operator approves by
 * calling the apply endpoint, the proposal's LATEST version body is
 * written to the KB doc — creating it if missing, or updating in
 * place. The proposal's status flips to "applied" so it cannot be
 * re-applied by mistake.
 *
 * Deliberately narrow:
 *   - Board-only application (agents propose, operators approve).
 *   - Single target KB doc per proposal (no cross-doc changes).
 *   - Three apply modes cover the common cases: wholesale replace
 *     (new character card), append (add a new faction entry to
 *     world/factions.md), prepend (insert a note at the top).
 *   - No diff preview in v1 — operators inspect the proposal's
 *     latest version body via the standard content-work-product
 *     endpoints before calling apply.
 */

export const BIBLE_UPDATE_PROPOSAL_TYPE = "bible_update_proposal";
export type BibleApplyMode = "replace" | "append" | "prepend";

export class NotABibleProposalError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "NotABibleProposalError";
  }
}

export interface AppliedBibleUpdate {
  proposalId: string;
  workProductId: string;
  kbDocumentId: string;
  kbPath: string;
  applyMode: BibleApplyMode;
  created: boolean;
  versionNumber: number;
}

function readStringMeta(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function readApplyMode(
  metadata: Record<string, unknown> | null | undefined,
): BibleApplyMode {
  const raw = readStringMeta(metadata, "applyMode");
  if (raw === "append" || raw === "prepend") return raw;
  return "replace";
}

function joinBody(existing: string, incoming: string, mode: BibleApplyMode): string {
  if (mode === "replace") return incoming;
  if (mode === "append") {
    if (!existing) return incoming;
    return existing.endsWith("\n") ? `${existing}${incoming}` : `${existing}\n\n${incoming}`;
  }
  // prepend
  if (!existing) return incoming;
  return incoming.endsWith("\n") ? `${incoming}${existing}` : `${incoming}\n\n${existing}`;
}

export function bibleUpdateService(db: Db) {
  const workProducts = contentWorkProductService(db);
  const kb = knowledgeBaseService(db);

  return {
    /**
     * Apply a Bible-update proposal to its target KB doc. Board-only;
     * the route layer enforces that via `assertBoard`. The proposal's
     * status is transitioned to "applied" on success so it can't be
     * re-applied. Returns a summary of what landed where.
     *
     * Ordering:
     *   1. Load the proposal WP (cross-tenant safe via companyId).
     *   2. Validate it's a bible_update_proposal with a target path.
     *   3. Load the proposal's latest body (refuses if there are
     *      no versions).
     *   4. Upsert the KB doc at (targetKbPath, targetKbProjectId).
     *   5. Mark the proposal as "applied" via a status PATCH (gate
     *      bypassed — "applied" is not a canonical gated state and
     *      the operator has already approved by calling this).
     */
    async applyBibleUpdate(
      companyId: string,
      proposalId: string,
      actor: { userId: string | null; agentId: string | null },
    ): Promise<AppliedBibleUpdate> {
      const wp = await workProducts.getWithLatest(companyId, proposalId);
      if (!wp) throw notFound("Content work product not found");
      if (wp.type !== BIBLE_UPDATE_PROPOSAL_TYPE) {
        throw new NotABibleProposalError(
          `Work product ${wp.id} is not a bible_update_proposal (type="${wp.type}")`,
        );
      }
      if (wp.status === "applied") {
        throw unprocessable("Bible update proposal has already been applied");
      }
      const targetPath = readStringMeta(wp.metadata, "targetKbPath");
      if (!targetPath) {
        throw unprocessable(
          "bible_update_proposal.metadata.targetKbPath is required before apply",
        );
      }
      const projectIdRaw = readStringMeta(wp.metadata, "targetKbProjectId");
      const projectId = projectIdRaw ?? null;
      const applyMode = readApplyMode(wp.metadata);

      if (!wp.latestVersion) {
        throw unprocessable("Bible update proposal has no content — add a version first");
      }
      const proposalBody = wp.latestVersion.body;

      const existingKb = await kb.getByPath(companyId, projectId, targetPath);
      let finalDocId: string;
      let created = false;

      if (existingKb) {
        const nextBody = joinBody(existingKb.body, proposalBody, applyMode);
        const updated = await kb.update(
          companyId,
          existingKb.id,
          { body: nextBody },
          { userId: actor.userId, agentId: actor.agentId },
        );
        finalDocId = updated.id;
      } else {
        if (applyMode !== "replace") {
          // Append / prepend require an existing doc to merge into.
          // Auto-create would silently treat them as "replace" which
          // is misleading — fail loudly instead.
          throw unprocessable(
            `Cannot ${applyMode} into non-existent KB doc "${targetPath}". Use applyMode "replace" for first-creation or create the doc first.`,
          );
        }
        const body = proposalBody;
        const titleFromWp = wp.title && wp.title.length > 0 ? wp.title : targetPath;
        const created_ = await kb.create(
          companyId,
          {
            projectId,
            path: targetPath,
            title: titleFromWp,
            // Proposals get translated into generic "custom" docs
            // unless metadata specified a kind. Keeps the KB
            // taxonomy author-driven.
            kind: readStringMeta(wp.metadata, "targetKbKind") ?? "custom",
            body,
            tags: [],
            frontmatter: {},
          },
          { userId: actor.userId, agentId: actor.agentId },
        );
        finalDocId = created_.id;
        created = true;
      }

      // Flip the proposal to "applied". This is NOT a canonical
      // gated state — we skip the pass-criteria enforcement via
      // bypass since the operator has explicitly approved by
      // calling this endpoint. The status change is audited via
      // the standard activity log the route emits.
      await workProducts.update(
        companyId,
        proposalId,
        { status: "applied" },
        { userId: actor.userId, agentId: actor.agentId },
        { bypass: true },
      );

      return {
        proposalId,
        workProductId: proposalId,
        kbDocumentId: finalDocId,
        kbPath: targetPath,
        applyMode,
        created,
        versionNumber: wp.latestVersion.versionNumber,
      };
    },
  };
}

export type BibleUpdateService = ReturnType<typeof bibleUpdateService>;
