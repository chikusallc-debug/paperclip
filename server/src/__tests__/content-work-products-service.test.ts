import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  contentWorkProducts,
  contentWorkProductVersions,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { contentWorkProductService } from "../services/content-work-products.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping content work products service tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("contentWorkProductService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-content-work-products-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(contentWorkProductVersions);
    await db.delete(contentWorkProducts);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(): Promise<{ companyId: string; projectId: string; agentId: string }> {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Neuroxcel",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Writer",
      role: "writer",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Chronoshard",
    });
    return { companyId, projectId, agentId };
  }

  it("creates a work product without an initial version", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "novel_chapter",
        title: "Chapter 1: Arrival",
        slug: "chapter-01",
        kind: "content",
        tags: ["act:1", "pov:elena"],
        metadata: { wordcountTarget: 5000 },
      },
      { userId: null, agentId, runId: null },
    );

    expect(wp.id).toBeTruthy();
    expect(wp.title).toBe("Chapter 1: Arrival");
    expect(wp.slug).toBe("chapter-01");
    expect(wp.tags).toEqual(["act:1", "pov:elena"]);
    expect(wp.metadata).toEqual({ wordcountTarget: 5000 });
    expect(wp.latestVersionNumber).toBe(0);
    expect(wp.latestVersionId).toBeNull();
    expect(wp.latestVersion).toBeNull();
    expect(wp.createdByAgentId).toBe(agentId);
  });

  it("creates a work product with an initial version", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "novel_chapter",
        title: "Chapter 1",
        initialBody: "# Chapter 1\n\nThe storm came at dawn.",
        initialFormat: "markdown",
        initialChangeSummary: "first draft",
      },
      { userId: null, agentId, runId: null },
    );

    expect(wp.latestVersionNumber).toBe(1);
    expect(wp.latestVersion).not.toBeNull();
    expect(wp.latestVersion?.body).toMatch(/storm came at dawn/);
    expect(wp.latestVersion?.versionNumber).toBe(1);
    expect(wp.latestVersion?.authoredByAgentId).toBe(agentId);
  });

  it("enforces slug uniqueness within a project", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    await svc.create(
      companyId,
      {
        projectId,
        type: "novel_chapter",
        title: "Chapter 1",
        slug: "chapter-01",
      },
      { userId: null, agentId, runId: null },
    );
    await expect(
      svc.create(
        companyId,
        {
          projectId,
          type: "novel_chapter",
          title: "Chapter 1 duplicate",
          slug: "chapter-01",
        },
        { userId: null, agentId, runId: null },
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("adds a new version and increments version numbers monotonically", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "novel_chapter",
        title: "Chapter 1",
        initialBody: "draft v1",
      },
      { userId: null, agentId, runId: null },
    );

    const v2 = await svc.addVersion(
      companyId,
      wp.id,
      { body: "draft v2", changeSummary: "tightened pacing", advanceStatusTo: "in_review" },
      { userId: null, agentId, runId: null },
    );
    expect(v2.versionNumber).toBe(2);
    expect(v2.parentVersionId).toBe(wp.latestVersion?.id);

    const v3 = await svc.addVersion(
      companyId,
      wp.id,
      { body: "draft v3" },
      { userId: null, agentId, runId: null },
    );
    expect(v3.versionNumber).toBe(3);

    const refreshed = await svc.getWithLatest(companyId, wp.id);
    expect(refreshed?.latestVersionNumber).toBe(3);
    expect(refreshed?.status).toBe("in_review");
    expect(refreshed?.latestVersion?.body).toBe("draft v3");

    const versions = await svc.listVersions(companyId, wp.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it("returns a specific version body by version number", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "C1", initialBody: "v1" },
      { userId: null, agentId, runId: null },
    );
    await svc.addVersion(companyId, wp.id, { body: "v2" }, { userId: null, agentId, runId: null });

    const v1 = await svc.getVersion(companyId, wp.id, 1);
    expect(v1.body).toBe("v1");
    const v2 = await svc.getVersion(companyId, wp.id, 2);
    expect(v2.body).toBe("v2");
  });

  it("publishes a specific version and marks status=published", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "C1", initialBody: "v1" },
      { userId: null, agentId, runId: null },
    );
    await svc.addVersion(companyId, wp.id, { body: "v2" }, { userId: null, agentId, runId: null });
    await svc.addVersion(companyId, wp.id, { body: "v3" }, { userId: null, agentId, runId: null });

    // Publish a specific older version rather than the latest.
    const published = await svc.publish(
      companyId,
      wp.id,
      { versionNumber: 2 },
      { userId: null, agentId },
    );
    expect(published.status).toBe("published");
    expect(published.publishedVersionId).toBeTruthy();
    const v2 = await svc.getVersion(companyId, wp.id, 2);
    expect(published.publishedVersionId).toBe(v2.id);
  });

  it("refuses to publish when no versions exist", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "C1" },
      { userId: null, agentId, runId: null },
    );
    await expect(
      svc.publish(companyId, wp.id, {}, { userId: null, agentId }),
    ).rejects.toThrow(/no versions/i);
  });

  it("updates editable fields and preserves versions", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "Draft title", initialBody: "body" },
      { userId: null, agentId, runId: null },
    );

    const updated = await svc.update(
      companyId,
      wp.id,
      { title: "Polished title", status: "in_review", tags: ["pov:nor"] },
      { userId: "u1", agentId: null },
    );
    expect(updated.title).toBe("Polished title");
    expect(updated.status).toBe("in_review");
    expect(updated.tags).toEqual(["pov:nor"]);
    expect(updated.updatedByUserId).toBe("u1");

    const versions = await svc.listVersions(companyId, wp.id);
    expect(versions.length).toBe(1);
  });

  it("scopes reads to companyId and refuses cross-tenant access", async () => {
    const a = await seed();
    const b = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      a.companyId,
      { projectId: a.projectId, type: "novel_chapter", title: "A" },
      { userId: null, agentId: a.agentId, runId: null },
    );

    // Company B cannot see A's work products.
    expect(await svc.getById(b.companyId, wp.id)).toBeNull();
    expect(await svc.getWithLatest(b.companyId, wp.id)).toBeNull();
    await expect(svc.listVersions(b.companyId, wp.id)).rejects.toThrow(/not found/i);
    await expect(
      svc.addVersion(
        b.companyId,
        wp.id,
        { body: "intruder" },
        { userId: null, agentId: b.agentId, runId: null },
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("filters listings by project, type, status, and kind", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "C1", status: "draft" },
      { userId: null, agentId, runId: null },
    );
    await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "C2", status: "in_review" },
      { userId: null, agentId, runId: null },
    );
    await svc.create(
      companyId,
      { projectId, type: "series_bible", kind: "reference", title: "Bible" },
      { userId: null, agentId, runId: null },
    );

    expect((await svc.list(companyId, { type: "novel_chapter" })).length).toBe(2);
    expect((await svc.list(companyId, { status: "draft" })).length).toBe(1);
    expect((await svc.list(companyId, { kind: "reference" })).length).toBe(1);
    expect((await svc.list(companyId, { projectId })).length).toBe(3);
  });

  it("cascades delete to versions", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const wp = await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "C1", initialBody: "body" },
      { userId: null, agentId, runId: null },
    );
    await svc.addVersion(companyId, wp.id, { body: "v2" }, { userId: null, agentId, runId: null });

    await svc.remove(companyId, wp.id);
    expect(await svc.getById(companyId, wp.id)).toBeNull();
    const remaining = await db.select().from(contentWorkProductVersions);
    expect(remaining.length).toBe(0);
  });

  it("rejects parentVersionId from a different work product", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);

    const a = await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "A", initialBody: "a" },
      { userId: null, agentId, runId: null },
    );
    const b = await svc.create(
      companyId,
      { projectId, type: "novel_chapter", title: "B", initialBody: "b" },
      { userId: null, agentId, runId: null },
    );

    await expect(
      svc.addVersion(
        companyId,
        a.id,
        { body: "forged", parentVersionId: b.latestVersion?.id ?? randomUUID() },
        { userId: null, agentId, runId: null },
      ),
    ).rejects.toThrow(/does not belong/i);
  });
});
