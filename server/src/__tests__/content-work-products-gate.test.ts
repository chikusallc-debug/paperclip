import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  contentWorkProductVersions,
  contentWorkProducts,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  contentWorkProductService,
  PassCriteriaError,
} from "../services/content-work-products.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping pass-criteria gate tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("content work product pass-criteria gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wp-gate-");
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

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Neuroxcel",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "W", role: "writer" });
    await db.insert(projects).values({ id: projectId, companyId, name: "S" });
    return { companyId, projectId, agentId };
  }

  it("blocks addVersion that advances a gated WP with failing body", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "novel_chapter",
        title: "C1",
        initialBody: "tiny",
        metadata: { passCriteria: { minWordcount: 100 } },
      },
      { userId: null, agentId, runId: null },
    );
    await expect(
      svc.addVersion(
        companyId,
        wp.id,
        { body: "still tiny", advanceStatusTo: "in_review" },
        { userId: null, agentId, runId: null },
      ),
    ).rejects.toBeInstanceOf(PassCriteriaError);
  });

  it("allows addVersion when body passes all criteria", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "novel_chapter",
        title: "C1",
        initialBody: "draft",
        metadata: { passCriteria: { minWordcount: 5 } },
      },
      { userId: null, agentId, runId: null },
    );
    const body = Array.from({ length: 50 }).fill("word").join(" ");
    const version = await svc.addVersion(
      companyId,
      wp.id,
      { body, advanceStatusTo: "in_review" },
      { userId: null, agentId, runId: null },
    );
    expect(version.versionNumber).toBe(2);
  });

  it("allows an advancing addVersion when WP has no criteria (backward compat)", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      { projectId, type: "t", title: "T", initialBody: "x" },
      { userId: null, agentId, runId: null },
    );
    const version = await svc.addVersion(
      companyId,
      wp.id,
      { body: "y", advanceStatusTo: "in_review" },
      { userId: null, agentId, runId: null },
    );
    expect(version.versionNumber).toBe(2);
  });

  it("does not gate transitions to non-gated targets (custom / draft)", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "t",
        title: "T",
        initialBody: "tiny",
        metadata: { passCriteria: { minWordcount: 100 } },
      },
      { userId: null, agentId, runId: null },
    );
    // "continuity_passed" is NOT in the gated set — transitions to it
    // are allowed even when criteria would fail for "in_review".
    const version = await svc.addVersion(
      companyId,
      wp.id,
      { body: "also tiny", advanceStatusTo: "continuity_passed" },
      { userId: null, agentId, runId: null },
    );
    expect(version.versionNumber).toBe(2);
  });

  it("blocks publish when latest version fails criteria", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "t",
        title: "T",
        initialBody: "short",
        metadata: { passCriteria: { minWordcount: 100 } },
      },
      { userId: null, agentId, runId: null },
    );
    await expect(
      svc.publish(companyId, wp.id, {}, { userId: null, agentId }),
    ).rejects.toBeInstanceOf(PassCriteriaError);
  });

  it("honors bypass on publish (board override)", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "t",
        title: "T",
        initialBody: "short",
        metadata: { passCriteria: { minWordcount: 100 } },
      },
      { userId: null, agentId, runId: null },
    );
    const published = await svc.publish(
      companyId,
      wp.id,
      {},
      { userId: "u1", agentId: null },
      { bypass: true },
    );
    expect(published.status).toBe("published");
  });

  it("blocks a PATCH status transition that fails criteria", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "t",
        title: "T",
        initialBody: "x",
        metadata: { passCriteria: { minWordcount: 100 } },
      },
      { userId: null, agentId, runId: null },
    );
    await expect(
      svc.update(companyId, wp.id, { status: "in_review" }, { userId: "u", agentId: null }),
    ).rejects.toBeInstanceOf(PassCriteriaError);
  });

  it("evaluateCriteria returns null result when no criteria configured", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      { projectId, type: "t", title: "T", initialBody: "x" },
      { userId: null, agentId, runId: null },
    );
    const evaluation = await svc.evaluateCriteria(companyId, wp.id);
    expect(evaluation.hasCriteria).toBe(false);
    expect(evaluation.result).toBeNull();
  });

  it("evaluateCriteria returns the failing rule list for gated WPs", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentWorkProductService(db);
    const wp = await svc.create(
      companyId,
      {
        projectId,
        type: "t",
        title: "T",
        initialBody: "x",
        metadata: {
          passCriteria: { minWordcount: 100, requiredTags: ["novel"] },
        },
      },
      { userId: null, agentId, runId: null },
    );
    const evaluation = await svc.evaluateCriteria(companyId, wp.id);
    expect(evaluation.hasCriteria).toBe(true);
    expect(evaluation.result?.passed).toBe(false);
    expect(evaluation.result?.failures.map((f) => f.code).sort()).toEqual(
      ["min_wordcount", "required_tags_missing"].sort(),
    );
    expect(evaluation.evaluatedAgainstVersionNumber).toBe(1);
  });
});
