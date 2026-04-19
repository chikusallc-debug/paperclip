import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  runDeploymentReadiness,
  redactReadinessForAnonymous,
  type DeploymentReadinessInput,
} from "../services/deployment-readiness.js";
import { serverVersion } from "../version.js";

function shouldExposeFullHealthDetails(
  actorType: "none" | "board" | "agent" | null | undefined,
  deploymentMode: DeploymentMode,
) {
  if (deploymentMode !== "authenticated") return true;
  return actorType === "board" || actorType === "agent";
}

export interface HealthRouteOptions {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  companyDeletionEnabled: boolean;
  /**
   * Deployment environment snapshot used to compute /health/ready. When
   * omitted the /ready route is still mounted but reports only database and
   * auth-runtime health (the pieces knowable from db + route opts alone).
   */
  readinessInput?: Omit<DeploymentReadinessInput, "deploymentMode" | "deploymentExposure" | "authReady">;
}

const DEFAULT_OPTS: HealthRouteOptions = {
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  authReady: true,
  companyDeletionEnabled: true,
};

export function healthRoutes(db?: Db, opts: HealthRouteOptions = DEFAULT_OPTS) {
  const router = Router();

  router.get("/", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );

    if (!db) {
      res.json(
        exposeFullDetails
          ? { status: "ok", version: serverVersion }
          : { status: "ok", deploymentMode: opts.deploymentMode },
      );
      return;
    }

    try {
      await db.execute(sql`SELECT 1`);
    } catch (error) {
      logger.warn({ err: error }, "Health check database probe failed");
      res.status(503).json({
        status: "unhealthy",
        version: serverVersion,
        error: "database_unreachable"
      });
      return;
    }

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (persistedDevServerStatus && typeof (db as { select?: unknown }).select === "function") {
      const instanceSettings = instanceSettingsService(db);
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    if (!exposeFullDetails) {
      res.json({
        status: "ok",
        deploymentMode: opts.deploymentMode,
        bootstrapStatus,
        bootstrapInviteActive,
      });
      return;
    }

    res.json({
      status: "ok",
      version: serverVersion,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  });

  // Minimal liveness probe: cheap, does not touch the database. Intended for
  // load balancers and orchestrators that must distinguish "process is up"
  // from "process is serving usable traffic".
  router.get("/live", (_req, res) => {
    res.json({ status: "ok", version: serverVersion });
  });

  // Deployment readiness probe: exercises runtime configuration (secrets
  // provider, storage, auth secret, backup dir, database) so operators can
  // monitor live misconfiguration from outside the box. Returns 503 when any
  // check is a hard fail.
  router.get("/ready", async (req, res) => {
    const actorType = "actor" in req ? req.actor?.type : null;
    const exposeFullDetails = shouldExposeFullHealthDetails(
      actorType,
      opts.deploymentMode,
    );

    const input: DeploymentReadinessInput | null = opts.readinessInput
      ? {
          deploymentMode: opts.deploymentMode,
          deploymentExposure: opts.deploymentExposure,
          authReady: opts.authReady,
          ...opts.readinessInput,
        }
      : null;

    if (!input) {
      // Caller did not wire runtime state; fall back to a minimal report.
      const dbCheck = db
        ? await db
            .execute(sql`SELECT 1`)
            .then(() => ({ name: "database", status: "pass" as const, message: "Database reachable" }))
            .catch((err) => ({
              name: "database",
              status: "fail" as const,
              message: "Database probe failed",
              details: { error: err instanceof Error ? err.message : String(err) },
            }))
        : { name: "database", status: "fail" as const, message: "Database handle not available" };
      const overall = dbCheck.status === "fail" ? "not_ready" : "ready";
      res.status(overall === "not_ready" ? 503 : 200).json({
        overall,
        checks: [dbCheck],
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    const report = await runDeploymentReadiness(db, input);
    const httpStatus = report.overall === "not_ready" ? 503 : 200;
    if (!exposeFullDetails) {
      res.status(httpStatus).json(redactReadinessForAnonymous(report));
      return;
    }
    res.status(httpStatus).json({ ...report, version: serverVersion });
  });

  return router;
}
