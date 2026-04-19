import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import {
  runDeploymentReadiness,
  redactReadinessForAnonymous,
  type DeploymentReadinessInput,
} from "../services/deployment-readiness.js";

function okDb(): Db {
  return {
    execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
  } as unknown as Db;
}

function failingDb(): Db {
  return {
    execute: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
  } as unknown as Db;
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeKeyFile(dir: string, mode = 0o600): string {
  const keyPath = path.join(dir, "master.key");
  fs.writeFileSync(keyPath, "a".repeat(44), { mode });
  fs.chmodSync(keyPath, mode);
  return keyPath;
}

function baseInput(overrides: Partial<DeploymentReadinessInput> = {}): DeploymentReadinessInput {
  const storageDir = makeTempDir("pc-ready-storage-");
  const backupDir = makeTempDir("pc-ready-backup-");
  const keyDir = makeTempDir("pc-ready-secrets-");
  return {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    bindHost: "127.0.0.1",
    allowedHostnames: [],
    authPublicBaseUrl: undefined,
    secretsProvider: "local_encrypted",
    secretsMasterKeyFilePath: makeKeyFile(keyDir),
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: storageDir,
    storageS3Bucket: undefined,
    databaseBackupEnabled: true,
    databaseBackupDir: backupDir,
    ...overrides,
  };
}

const ORIGINAL_ENV = { ...process.env };

describe("runDeploymentReadiness", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("returns overall=ready in a healthy local_trusted deployment", async () => {
    const report = await runDeploymentReadiness(okDb(), baseInput());
    expect(report.overall).toBe("ready");
    for (const check of report.checks) {
      expect(check.status).toBe("pass");
    }
  });

  it("returns overall=not_ready when the database probe fails", async () => {
    const report = await runDeploymentReadiness(failingDb(), baseInput());
    expect(report.overall).toBe("not_ready");
    const db = report.checks.find((c) => c.name === "database");
    expect(db?.status).toBe("fail");
  });

  it("fails when authenticated mode is missing BETTER_AUTH_SECRET", async () => {
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
      }),
    );
    const secret = report.checks.find((c) => c.name === "auth_secret");
    expect(secret?.status).toBe("fail");
    expect(report.overall).toBe("not_ready");
  });

  it("fails when BETTER_AUTH_SECRET is a known dev sentinel", async () => {
    process.env.BETTER_AUTH_SECRET = "paperclip-dev-secret";
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
      }),
    );
    const secret = report.checks.find((c) => c.name === "auth_secret");
    expect(secret?.status).toBe("fail");
    expect(secret?.message).toMatch(/development default/);
  });

  it("warns when BETTER_AUTH_SECRET is too short", async () => {
    process.env.BETTER_AUTH_SECRET = "short-key-12"; // 12 chars
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
      }),
    );
    const secret = report.checks.find((c) => c.name === "auth_secret");
    expect(secret?.status).toBe("warn");
    expect(report.overall).toBe("degraded");
  });

  it("passes when authenticated mode has a strong BETTER_AUTH_SECRET", async () => {
    process.env.BETTER_AUTH_SECRET = "0123456789abcdef0123456789abcdef"; // 32 chars
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        deploymentMode: "authenticated",
        deploymentExposure: "private",
      }),
    );
    const secret = report.checks.find((c) => c.name === "auth_secret");
    expect(secret?.status).toBe("pass");
  });

  it("fails in authenticated/public when publicBaseUrl is missing", async () => {
    process.env.BETTER_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authPublicBaseUrl: undefined,
      }),
    );
    const pub = report.checks.find((c) => c.name === "public_url");
    expect(pub?.status).toBe("fail");
  });

  it("warns when public exposure uses http instead of https", async () => {
    process.env.BETTER_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authPublicBaseUrl: "http://example.com",
        allowedHostnames: ["example.com"],
      }),
    );
    const pub = report.checks.find((c) => c.name === "public_url");
    expect(pub?.status).toBe("warn");
    expect(pub?.message).toMatch(/https/);
  });

  it("warns when publicBaseUrl host is not in allowedHostnames", async () => {
    process.env.BETTER_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        authPublicBaseUrl: "https://desk.example.com",
        allowedHostnames: [],
      }),
    );
    const pub = report.checks.find((c) => c.name === "public_url");
    expect(pub?.status).toBe("warn");
    expect(pub?.message).toMatch(/allowedHostnames/);
  });

  it("fails when local_trusted mode is bound to a non-loopback host", async () => {
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({ bindHost: "0.0.0.0" }),
    );
    const bind = report.checks.find((c) => c.name === "bind_safety");
    expect(bind?.status).toBe("fail");
    expect(report.overall).toBe("not_ready");
  });

  it("warns when secrets key file does not exist", async () => {
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        secretsMasterKeyFilePath: path.join(os.tmpdir(), "does-not-exist-xyz.key"),
      }),
    );
    const sec = report.checks.find((c) => c.name === "secrets_provider");
    expect(sec?.status).toBe("warn");
  });

  it("fails when secrets key file has world-readable permissions", async () => {
    if (process.platform === "win32") return; // Windows has no POSIX mode
    const dir = makeTempDir("pc-ready-perm-");
    const keyPath = makeKeyFile(dir, 0o644);
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({ secretsMasterKeyFilePath: keyPath }),
    );
    const sec = report.checks.find((c) => c.name === "secrets_provider");
    expect(sec?.status).toBe("fail");
    expect(sec?.message).toMatch(/permissions/);
  });

  it("passes secrets provider when key is supplied via env var", async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "x".repeat(32);
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        secretsMasterKeyFilePath: path.join(os.tmpdir(), "missing-but-fine.key"),
      }),
    );
    const sec = report.checks.find((c) => c.name === "secrets_provider");
    expect(sec?.status).toBe("pass");
  });

  it("fails when local_disk storage dir is not writable", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    // Create a file and try to treat it as a directory — mkdir on this path
    // always fails with ENOTDIR, regardless of ambient permissions.
    const parent = makeTempDir("pc-ready-bad-");
    const filePath = path.join(parent, "not-a-dir");
    fs.writeFileSync(filePath, "blocker");
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({ storageLocalDiskBaseDir: path.join(filePath, "nope") }),
    );
    const st = report.checks.find((c) => c.name === "storage");
    expect(st?.status).toBe("fail");
  });

  it("passes S3 storage when bucket is configured", async () => {
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        storageProvider: "s3",
        storageS3Bucket: "my-bucket",
        storageLocalDiskBaseDir: undefined,
      }),
    );
    const st = report.checks.find((c) => c.name === "storage");
    expect(st?.status).toBe("pass");
  });

  it("fails S3 storage without bucket", async () => {
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({
        storageProvider: "s3",
        storageS3Bucket: undefined,
        storageLocalDiskBaseDir: undefined,
      }),
    );
    const st = report.checks.find((c) => c.name === "storage");
    expect(st?.status).toBe("fail");
  });

  it("warns when database backups are disabled", async () => {
    const report = await runDeploymentReadiness(
      okDb(),
      baseInput({ databaseBackupEnabled: false }),
    );
    const bk = report.checks.find((c) => c.name === "database_backup");
    expect(bk?.status).toBe("warn");
    expect(report.overall).toBe("degraded");
  });
});

describe("redactReadinessForAnonymous", () => {
  it("removes details and replaces passing messages with ok", () => {
    const report = {
      overall: "degraded" as const,
      checkedAt: "2026-01-01T00:00:00.000Z",
      checks: [
        {
          name: "database",
          status: "pass" as const,
          message: "Database reachable",
          details: { server: "internal" },
        },
        {
          name: "storage",
          status: "warn" as const,
          message: "Backup directory is writable (/very/secret/path)",
          details: { baseDir: "/very/secret/path" },
        },
      ],
    };
    const redacted = redactReadinessForAnonymous(report);
    expect(redacted.checks[0]!.message).toBe("ok");
    expect(redacted.checks[0]).not.toHaveProperty("details");
    expect(redacted.checks[1]!.message).toMatch(/very\/secret\/path/);
    expect(redacted.checks[1]).not.toHaveProperty("details");
  });
});
