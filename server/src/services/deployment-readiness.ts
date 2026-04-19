import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import type {
  DeploymentExposure,
  DeploymentMode,
  SecretProvider,
  StorageProvider as StorageProviderId,
} from "@paperclipai/shared";

export type ReadinessStatus = "pass" | "warn" | "fail";
export type ReadinessOverall = "ready" | "degraded" | "not_ready";

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  message: string;
  /**
   * Structured details for operators. Never includes secret values. Omitted
   * from the public response when the caller is not an admin/agent actor.
   */
  details?: Record<string, unknown>;
}

export interface ReadinessReport {
  overall: ReadinessOverall;
  checks: ReadinessCheck[];
  checkedAt: string;
}

export interface DeploymentReadinessInput {
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  authReady: boolean;
  bindHost: string;
  allowedHostnames: string[];
  authPublicBaseUrl: string | undefined;
  /** secret provider id (e.g. "local_encrypted") */
  secretsProvider: SecretProvider;
  /** secrets master key file resolved by config */
  secretsMasterKeyFilePath: string;
  /** storage provider id (local_disk | s3) */
  storageProvider: StorageProviderId;
  /** local_disk base dir (only used when provider is local_disk) */
  storageLocalDiskBaseDir?: string | undefined;
  /** S3 bucket (only used when provider is s3) */
  storageS3Bucket?: string | undefined;
  databaseBackupEnabled: boolean;
  databaseBackupDir?: string | undefined;
}

/**
 * Values that strongly indicate an operator left a development default in
 * place and need to be rejected before trusting the deployment.
 */
const KNOWN_WEAK_AUTH_SECRETS = new Set([
  "paperclip-dev-secret",
  "test-secret",
  "changeme",
  "change-me",
  "secret",
  "dev",
  "development",
]);

const MIN_AUTH_SECRET_LENGTH = 16;

function overallFrom(checks: ReadinessCheck[]): ReadinessOverall {
  if (checks.some((c) => c.status === "fail")) return "not_ready";
  if (checks.some((c) => c.status === "warn")) return "degraded";
  return "ready";
}

function isLoopbackHost(host: string): boolean {
  const n = host.trim().toLowerCase();
  return n === "127.0.0.1" || n === "localhost" || n === "::1";
}

async function checkDatabase(db: Db | undefined): Promise<ReadinessCheck> {
  if (!db) {
    return {
      name: "database",
      status: "fail",
      message: "Database handle not available",
    };
  }
  try {
    await db.execute(sql`SELECT 1`);
    return { name: "database", status: "pass", message: "Database reachable" };
  } catch (err) {
    return {
      name: "database",
      status: "fail",
      message: "Database probe failed",
      details: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

function checkAuthSecret(input: DeploymentReadinessInput): ReadinessCheck {
  if (input.deploymentMode !== "authenticated") {
    return {
      name: "auth_secret",
      status: "pass",
      message: "Not applicable in local_trusted mode",
    };
  }
  const secret =
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ||
    "";
  if (!secret) {
    return {
      name: "auth_secret",
      status: "fail",
      message:
        "authenticated mode requires BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET)",
    };
  }
  if (KNOWN_WEAK_AUTH_SECRETS.has(secret.toLowerCase())) {
    return {
      name: "auth_secret",
      status: "fail",
      message:
        "BETTER_AUTH_SECRET is set to a well-known development default; rotate it before serving real traffic",
    };
  }
  if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    return {
      name: "auth_secret",
      status: "warn",
      message: `BETTER_AUTH_SECRET is shorter than ${MIN_AUTH_SECRET_LENGTH} characters; prefer 32+ bytes of entropy`,
      details: { length: secret.length },
    };
  }
  return {
    name: "auth_secret",
    status: "pass",
    message: "BETTER_AUTH_SECRET present with adequate length",
  };
}

async function checkSecretsProvider(
  input: DeploymentReadinessInput,
): Promise<ReadinessCheck> {
  if (input.secretsProvider !== "local_encrypted") {
    return {
      name: "secrets_provider",
      status: "pass",
      message: `External secret provider configured: ${input.secretsProvider}`,
    };
  }
  const envKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY?.trim();
  if (envKey) {
    return {
      name: "secrets_provider",
      status: "pass",
      message: "local_encrypted master key supplied via PAPERCLIP_SECRETS_MASTER_KEY",
    };
  }
  const keyPath = input.secretsMasterKeyFilePath;
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    stat = await fs.stat(keyPath);
  } catch {
    return {
      name: "secrets_provider",
      status: "warn",
      message: `local_encrypted master key file missing: ${keyPath}`,
      details: { keyFilePath: keyPath },
    };
  }
  if (process.platform !== "win32") {
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      return {
        name: "secrets_provider",
        status: "fail",
        message: `local_encrypted master key file has world/group-readable permissions (${mode.toString(8)}); must be 0600`,
        details: { keyFilePath: keyPath, mode: mode.toString(8) },
      };
    }
  }
  return {
    name: "secrets_provider",
    status: "pass",
    message: `local_encrypted master key file present with safe permissions`,
    details: { keyFilePath: keyPath },
  };
}

function checkPublicUrl(input: DeploymentReadinessInput): ReadinessCheck {
  if (input.deploymentMode !== "authenticated" || input.deploymentExposure !== "public") {
    return {
      name: "public_url",
      status: "pass",
      message: "Not applicable (requires authenticated/public)",
    };
  }
  const url = input.authPublicBaseUrl?.trim();
  if (!url) {
    return {
      name: "public_url",
      status: "fail",
      message: "authenticated/public requires auth.publicBaseUrl",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      name: "public_url",
      status: "fail",
      message: "auth.publicBaseUrl is not a valid URL",
      details: { url },
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      name: "public_url",
      status: "warn",
      message: "Public exposure should use https:// for secure session cookies",
      details: { protocol: parsed.protocol },
    };
  }
  if (!input.allowedHostnames.includes(parsed.hostname.toLowerCase())) {
    return {
      name: "public_url",
      status: "warn",
      message: `publicBaseUrl host ${parsed.hostname} is not present in allowedHostnames`,
      details: { hostname: parsed.hostname, allowedHostnames: input.allowedHostnames },
    };
  }
  return {
    name: "public_url",
    status: "pass",
    message: `Public base URL looks healthy (${parsed.hostname})`,
  };
}

function checkBindSafety(input: DeploymentReadinessInput): ReadinessCheck {
  if (input.deploymentMode === "local_trusted") {
    if (!isLoopbackHost(input.bindHost)) {
      return {
        name: "bind_safety",
        status: "fail",
        message: `local_trusted mode must bind to loopback (got ${input.bindHost})`,
      };
    }
    return {
      name: "bind_safety",
      status: "pass",
      message: "Loopback-only bind is correct for local_trusted",
    };
  }
  if (input.deploymentExposure === "public" && input.bindHost === "0.0.0.0") {
    return {
      name: "bind_safety",
      status: "warn",
      message:
        "Server is bound to 0.0.0.0 in authenticated/public mode; confirm a reverse proxy terminates TLS in front of Paperclip",
    };
  }
  return {
    name: "bind_safety",
    status: "pass",
    message: `Bind host ${input.bindHost} is consistent with ${input.deploymentMode}/${input.deploymentExposure}`,
  };
}

async function checkStorage(input: DeploymentReadinessInput): Promise<ReadinessCheck> {
  if (input.storageProvider === "s3") {
    const bucket = input.storageS3Bucket?.trim();
    if (!bucket) {
      return {
        name: "storage",
        status: "fail",
        message: "S3 storage provider selected but bucket is not configured",
      };
    }
    return {
      name: "storage",
      status: "pass",
      message: `S3 storage configured (bucket=${bucket})`,
      details: { bucket },
    };
  }
  const baseDir = input.storageLocalDiskBaseDir;
  if (!baseDir) {
    return {
      name: "storage",
      status: "fail",
      message: "local_disk storage provider has no base directory configured",
    };
  }
  const probePath = path.join(
    baseDir,
    `.readiness-probe-${randomBytes(4).toString("hex")}`,
  );
  try {
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(probePath, "ok", { mode: 0o600 });
    await fs.unlink(probePath);
    return {
      name: "storage",
      status: "pass",
      message: `local_disk storage is writable (${baseDir})`,
      details: { baseDir },
    };
  } catch (err) {
    return {
      name: "storage",
      status: "fail",
      message: `local_disk storage is not writable (${baseDir})`,
      details: {
        baseDir,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function checkBackup(input: DeploymentReadinessInput): Promise<ReadinessCheck> {
  if (!input.databaseBackupEnabled) {
    return {
      name: "database_backup",
      status: "warn",
      message: "Automatic database backups are disabled",
    };
  }
  const dir = input.databaseBackupDir;
  if (!dir) {
    return {
      name: "database_backup",
      status: "warn",
      message: "Automatic database backups are enabled but no backup directory is configured",
    };
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir);
    return {
      name: "database_backup",
      status: "pass",
      message: `Backup directory is writable (${dir})`,
      details: { backupDir: dir },
    };
  } catch (err) {
    return {
      name: "database_backup",
      status: "fail",
      message: `Backup directory is not usable (${dir})`,
      details: {
        backupDir: dir,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

function checkAuthReady(input: DeploymentReadinessInput): ReadinessCheck {
  if (input.deploymentMode !== "authenticated") {
    return {
      name: "auth_runtime",
      status: "pass",
      message: "Not applicable in local_trusted mode",
    };
  }
  if (!input.authReady) {
    return {
      name: "auth_runtime",
      status: "fail",
      message: "authenticated mode is configured but auth runtime is not initialized",
    };
  }
  return {
    name: "auth_runtime",
    status: "pass",
    message: "Better Auth runtime initialized",
  };
}

/**
 * Run all readiness checks against a running server. Pure functions plus a
 * live DB probe; all I/O is bounded and safe to call from a request handler
 * or startup hook.
 */
export async function runDeploymentReadiness(
  db: Db | undefined,
  input: DeploymentReadinessInput,
): Promise<ReadinessReport> {
  const checks = await Promise.all([
    checkDatabase(db),
    Promise.resolve(checkAuthReady(input)),
    Promise.resolve(checkAuthSecret(input)),
    checkSecretsProvider(input),
    Promise.resolve(checkPublicUrl(input)),
    Promise.resolve(checkBindSafety(input)),
    checkStorage(input),
    checkBackup(input),
  ]);
  return {
    overall: overallFrom(checks),
    checks,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Summary form for anonymous callers. Avoids exposing hostnames, paths, or
 * other operational data that would aid an attacker probing the deployment.
 */
export function redactReadinessForAnonymous(report: ReadinessReport): ReadinessReport {
  return {
    overall: report.overall,
    checkedAt: report.checkedAt,
    checks: report.checks.map((c) => ({
      name: c.name,
      status: c.status,
      message: c.status === "pass" ? "ok" : c.message,
    })),
  };
}
