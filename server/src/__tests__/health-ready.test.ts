import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { healthRoutes } from "../routes/health.js";

vi.mock("../dev-server-status.js", () => ({
  readPersistedDevServerStatus: () => undefined,
  toDevServerHealthStatus: vi.fn(),
}));

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

function makeKeyFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-health-key-"));
  const keyPath = path.join(dir, "master.key");
  fs.writeFileSync(keyPath, "a".repeat(44), { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return keyPath;
}

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pc-health-dir-"));
}

function mountApp(
  db: Db,
  opts: Parameters<typeof healthRoutes>[1] & object,
  actor?: { type: "board" | "agent" | "none"; userId?: string },
) {
  const app = express();
  if (actor) {
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
  }
  app.use("/health", healthRoutes(db, opts));
  return app;
}

const ORIGINAL_ENV = { ...process.env };

describe("GET /health/live", () => {
  it("responds 200 without touching the database", async () => {
    const db = { execute: vi.fn() } as unknown as Db;
    const app = mountApp(db, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    });
    const res = await request(app).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe("GET /health/ready", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns 200/ready for a healthy local_trusted deployment", async () => {
    const app = mountApp(okDb(), {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      readinessInput: {
        bindHost: "127.0.0.1",
        allowedHostnames: [],
        authPublicBaseUrl: undefined,
        secretsProvider: "local_encrypted",
        secretsMasterKeyFilePath: makeKeyFile(),
        storageProvider: "local_disk",
        storageLocalDiskBaseDir: makeDir(),
        storageS3Bucket: undefined,
        databaseBackupEnabled: true,
        databaseBackupDir: makeDir(),
      },
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.overall).toBe("ready");
    expect(Array.isArray(res.body.checks)).toBe(true);
  });

  it("returns 503 when a hard check fails", async () => {
    const app = mountApp(failingDb(), {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
      readinessInput: {
        bindHost: "127.0.0.1",
        allowedHostnames: [],
        authPublicBaseUrl: undefined,
        secretsProvider: "local_encrypted",
        secretsMasterKeyFilePath: makeKeyFile(),
        storageProvider: "local_disk",
        storageLocalDiskBaseDir: makeDir(),
        storageS3Bucket: undefined,
        databaseBackupEnabled: true,
        databaseBackupDir: makeDir(),
      },
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body.overall).toBe("not_ready");
  });

  it("redacts details for anonymous requests in authenticated mode", async () => {
    process.env.BETTER_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    const app = mountApp(
      okDb(),
      {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
        readinessInput: {
          bindHost: "0.0.0.0",
          allowedHostnames: ["example.com"],
          authPublicBaseUrl: "https://example.com",
          secretsProvider: "local_encrypted",
          secretsMasterKeyFilePath: makeKeyFile(),
          storageProvider: "local_disk",
          storageLocalDiskBaseDir: makeDir(),
          storageS3Bucket: undefined,
          databaseBackupEnabled: true,
          databaseBackupDir: makeDir(),
        },
      },
      { type: "none" },
    );
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    for (const check of res.body.checks) {
      // Non-pass messages remain visible; passing ones are compressed to "ok".
      if (check.status === "pass") expect(check.message).toBe("ok");
      // Never any details for anonymous callers.
      expect(check.details).toBeUndefined();
    }
  });

  it("exposes full details for board actors", async () => {
    process.env.BETTER_AUTH_SECRET = "0123456789abcdef0123456789abcdef";
    const app = mountApp(
      okDb(),
      {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
        readinessInput: {
          bindHost: "127.0.0.1",
          allowedHostnames: [],
          authPublicBaseUrl: undefined,
          secretsProvider: "local_encrypted",
          secretsMasterKeyFilePath: makeKeyFile(),
          storageProvider: "local_disk",
          storageLocalDiskBaseDir: makeDir(),
          storageS3Bucket: undefined,
          databaseBackupEnabled: true,
          databaseBackupDir: makeDir(),
        },
      },
      { type: "board", userId: "u1" },
    );
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.overall).toBe("ready");
    const storage = res.body.checks.find((c: { name: string }) => c.name === "storage");
    expect(storage?.details?.baseDir).toBeTruthy();
  });

  it("falls back to db-only readiness when readinessInput is omitted", async () => {
    const app = mountApp(okDb(), {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
      companyDeletionEnabled: true,
    });
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body.overall).toBe("ready");
    expect(res.body.checks).toHaveLength(1);
    expect(res.body.checks[0].name).toBe("database");
  });
});
