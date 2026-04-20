import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createPublishingTargetSchema,
  updatePublishingTargetSchema,
  publishWorkProductSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logActivity, publishingService } from "../services/index.js";

export function publishingRoutes(db: Db) {
  const router = Router();
  const svc = publishingService(db);

  // ---- Target CRUD ----

  router.get("/companies/:companyId/publishing-targets", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listTargets(companyId));
  });

  router.post(
    "/companies/:companyId/publishing-targets",
    validate(createPublishingTargetSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const target = await svc.createTarget(companyId, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "publishing_target.created",
        entityType: "publishing_target",
        entityId: target.id,
        details: { name: target.name, type: target.type },
      });
      res.status(201).json(target);
    },
  );

  router.get("/publishing-targets/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyIdForTarget(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Publishing target not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const target = await svc.getTargetById(companyId, id);
    if (!target) {
      res.status(404).json({ error: "Publishing target not found" });
      return;
    }
    res.json(target);
  });

  router.patch(
    "/publishing-targets/:id",
    validate(updatePublishingTargetSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const companyId = await resolveCompanyIdForTarget(db, id);
      if (!companyId) {
        res.status(404).json({ error: "Publishing target not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const target = await svc.updateTarget(companyId, id, req.body, {
        userId: actor.actorType === "user" ? actor.actorId : null,
        agentId: actor.agentId,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "publishing_target.updated",
        entityType: "publishing_target",
        entityId: target.id,
        details: { patch: req.body },
      });
      res.json(target);
    },
  );

  router.delete("/publishing-targets/:id", async (req, res) => {
    const id = req.params.id as string;
    const companyId = await resolveCompanyIdForTarget(db, id);
    if (!companyId) {
      res.status(404).json({ error: "Publishing target not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    await svc.removeTarget(companyId, id);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "publishing_target.deleted",
      entityType: "publishing_target",
      entityId: id,
      details: {},
    });
    res.status(204).send();
  });

  // ---- Publish ----

  router.post(
    "/content-work-products/:id/publish-to/:targetId",
    validate(publishWorkProductSchema),
    async (req, res) => {
      const workProductId = req.params.id as string;
      const targetId = req.params.targetId as string;
      // Resolve the work product's company first — publishing is
      // scoped by the work product's company, and the target must
      // belong to the same company (enforced in the service).
      const companyId = await resolveCompanyIdForWorkProduct(db, workProductId);
      if (!companyId) {
        res.status(404).json({ error: "Content work product not found" });
        return;
      }
      assertCompanyAccess(req, companyId);
      const targetCompanyId = await resolveCompanyIdForTarget(db, targetId);
      if (!targetCompanyId || targetCompanyId !== companyId) {
        res.status(404).json({ error: "Publishing target not found" });
        return;
      }
      const actor = getActorInfo(req);
      const attempt = await svc.publishWorkProduct(
        companyId,
        workProductId,
        targetId,
        req.body ?? {},
        {
          userId: actor.actorType === "user" ? actor.actorId : null,
          agentId: actor.agentId,
        },
      );
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "publish_attempt.completed",
        entityType: "publish_attempt",
        entityId: attempt.id,
        details: {
          workProductId,
          targetId,
          status: attempt.status,
          httpStatus: attempt.httpStatus,
          durationMs: attempt.durationMs,
        },
      });
      // Surface failed-but-recorded attempts as 200 OK with status:
      // "failed" in the body. Operators can distinguish a failed
      // publish from "we never reached the provider" (which is 400/
      // 422 with an error message).
      res.status(201).json(attempt);
    },
  );

  router.get("/content-work-products/:id/publish-attempts", async (req, res) => {
    const workProductId = req.params.id as string;
    const companyId = await resolveCompanyIdForWorkProduct(db, workProductId);
    if (!companyId) {
      res.status(404).json({ error: "Content work product not found" });
      return;
    }
    assertCompanyAccess(req, companyId);
    res.json(await svc.listAttemptsForWorkProduct(companyId, workProductId));
  });

  return router;
}

async function resolveCompanyIdForTarget(db: Db, id: string): Promise<string | null> {
  const { publishingTargets } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ companyId: publishingTargets.companyId })
    .from(publishingTargets)
    .where(eq(publishingTargets.id, id));
  return rows[0]?.companyId ?? null;
}

async function resolveCompanyIdForWorkProduct(db: Db, id: string): Promise<string | null> {
  const { contentWorkProducts } = await import("@paperclipai/db");
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({ companyId: contentWorkProducts.companyId })
    .from(contentWorkProducts)
    .where(eq(contentWorkProducts.id, id));
  return rows[0]?.companyId ?? null;
}
