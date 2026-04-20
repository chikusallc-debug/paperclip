import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  contentWorkProductVersions,
  contentWorkProducts,
  createDb,
  projects,
  publishAttempts,
  publishingTargets,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { publishingService } from "../services/publishing.ts";
import { contentWorkProductService } from "../services/content-work-products.ts";
import { secretService } from "../services/secrets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping publishing service tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("publishingService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-publishing-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(publishAttempts);
    await db.delete(publishingTargets);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(contentWorkProductVersions);
    await db.delete(contentWorkProducts);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Neuroxcel",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Launcher",
      role: "launcher",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Saga" });
    return { companyId, agentId, projectId };
  }

  async function seedWorkProductWithVersion(companyId: string, agentId: string) {
    const wps = contentWorkProductService(db);
    const wp = await wps.create(
      companyId,
      {
        type: "novel_chapter",
        title: "Chapter 1",
        initialBody: "# Chapter 1\n\nHello",
      },
      { userId: null, agentId, runId: null },
    );
    return wp;
  }

  it("creates a target, requires HTTPS, and publishes via the webhook provider", async () => {
    const { companyId, agentId } = await seed();
    const fetchImpl = vi.fn(async (_url, init) =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    const svc = publishingService(db, { fetchImpl });

    const target = await svc.createTarget(
      companyId,
      {
        name: "gumroad",
        type: "webhook",
        config: { url: "https://api.example.com/hook" },
        enabled: true,
      },
      { userId: null, agentId },
    );
    expect(target.type).toBe("webhook");
    expect(target.enabled).toBe(true);

    const wp = await seedWorkProductWithVersion(companyId, agentId);
    const attempt = await svc.publishWorkProduct(
      companyId,
      wp.id,
      target.id,
      {},
      { userId: null, agentId },
    );
    expect(attempt.status).toBe("success");
    expect(attempt.httpStatus).toBe(200);
    expect(attempt.completedAt).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects attempts when no versions exist yet", async () => {
    const { companyId, agentId } = await seed();
    const svc = publishingService(db, { fetchImpl: vi.fn() as unknown as typeof fetch });
    const target = await svc.createTarget(
      companyId,
      {
        name: "t",
        type: "webhook",
        config: { url: "https://x.example/y" },
        enabled: true,
      },
      { userId: null, agentId },
    );
    const wps = contentWorkProductService(db);
    const wp = await wps.create(
      companyId,
      { type: "t", title: "T" }, // no initialBody — latestVersionNumber=0
      { userId: null, agentId, runId: null },
    );
    await expect(
      svc.publishWorkProduct(companyId, wp.id, target.id, {}, { userId: null, agentId }),
    ).rejects.toThrow(/no versions/i);
  });

  it("refuses to publish through a disabled target", async () => {
    const { companyId, agentId } = await seed();
    const svc = publishingService(db, { fetchImpl: vi.fn() as unknown as typeof fetch });
    const target = await svc.createTarget(
      companyId,
      {
        name: "t",
        type: "webhook",
        config: { url: "https://x.example/y" },
        enabled: false,
      },
      { userId: null, agentId },
    );
    const wp = await seedWorkProductWithVersion(companyId, agentId);
    await expect(
      svc.publishWorkProduct(companyId, wp.id, target.id, {}, { userId: null, agentId }),
    ).rejects.toThrow(/disabled/i);
  });

  it("resolves the target's secret and threads it into the provider auth header", async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "x".repeat(32);
    const { companyId, agentId } = await seed();
    const secretsSvc = secretService(db);
    const secret = await secretsSvc.create(
      companyId,
      { name: "gumroad_api_key", provider: "local_encrypted", value: "super-sekret" },
      { userId: "u", agentId: null },
    );

    let lastHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url, init) => {
      lastHeaders = init!.headers as Record<string, string>;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const svc = publishingService(db, { fetchImpl });

    const target = await svc.createTarget(
      companyId,
      {
        name: "gumroad",
        type: "webhook",
        config: { url: "https://api.example.com/hook" },
        secretId: secret.id,
        enabled: true,
      },
      { userId: null, agentId },
    );
    const wp = await seedWorkProductWithVersion(companyId, agentId);
    const attempt = await svc.publishWorkProduct(
      companyId,
      wp.id,
      target.id,
      {},
      { userId: null, agentId },
    );
    expect(attempt.status).toBe("success");
    expect(lastHeaders["Authorization"]).toBe("Bearer super-sekret");
    // The secret value must NEVER land in the persisted attempt summaries.
    expect(JSON.stringify(attempt)).not.toContain("super-sekret");
  });

  it("rejects creating a target that references a cross-tenant secret", async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "x".repeat(32);
    const a = await seed();
    const b = await seed();
    const secretsSvc = secretService(db);
    const secretA = await secretsSvc.create(
      a.companyId,
      { name: "leak", provider: "local_encrypted", value: "hidden" },
      { userId: "u", agentId: null },
    );
    const svc = publishingService(db, { fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(
      svc.createTarget(
        b.companyId,
        {
          name: "x",
          type: "webhook",
          config: { url: "https://x.example/y" },
          secretId: secretA.id,
          enabled: true,
        },
        { userId: null, agentId: b.agentId },
      ),
    ).rejects.toThrow(/does not belong to this company/i);
  });

  it("records a failed attempt when the provider returns non-2xx (still a DB row)", async () => {
    const { companyId, agentId } = await seed();
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 500 })) as unknown as typeof fetch;
    const svc = publishingService(db, { fetchImpl });
    const target = await svc.createTarget(
      companyId,
      {
        name: "t",
        type: "webhook",
        config: { url: "https://api.example.com/hook" },
        enabled: true,
      },
      { userId: null, agentId },
    );
    const wp = await seedWorkProductWithVersion(companyId, agentId);
    const attempt = await svc.publishWorkProduct(
      companyId,
      wp.id,
      target.id,
      {},
      { userId: null, agentId },
    );
    expect(attempt.status).toBe("failed");
    expect(attempt.httpStatus).toBe(500);
    const attempts = await svc.listAttemptsForWorkProduct(companyId, wp.id);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.status).toBe("failed");
  });

  it("enforces target name uniqueness per company (scoped allowance across companies)", async () => {
    const a = await seed();
    const b = await seed();
    const svc = publishingService(db, { fetchImpl: vi.fn() as unknown as typeof fetch });
    await svc.createTarget(
      a.companyId,
      { name: "gumroad", type: "webhook", config: { url: "https://x.example/y" }, enabled: true },
      { userId: null, agentId: a.agentId },
    );
    await expect(
      svc.createTarget(
        a.companyId,
        { name: "gumroad", type: "webhook", config: { url: "https://x.example/z" }, enabled: true },
        { userId: null, agentId: a.agentId },
      ),
    ).rejects.toThrow(/already exists/i);
    // Same name in a different company is fine.
    await svc.createTarget(
      b.companyId,
      { name: "gumroad", type: "webhook", config: { url: "https://x.example/z" }, enabled: true },
      { userId: null, agentId: b.agentId },
    );
  });

  it("scopes reads by company", async () => {
    const a = await seed();
    const b = await seed();
    const svc = publishingService(db, { fetchImpl: vi.fn() as unknown as typeof fetch });
    const targetA = await svc.createTarget(
      a.companyId,
      { name: "t", type: "webhook", config: { url: "https://x.example/y" }, enabled: true },
      { userId: null, agentId: a.agentId },
    );
    expect(await svc.getTargetById(b.companyId, targetA.id)).toBeNull();
  });
});
