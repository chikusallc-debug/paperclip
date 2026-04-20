import { describe, expect, it, vi } from "vitest";
import {
  bibleUpdateService,
  BIBLE_UPDATE_PROPOSAL_TYPE,
} from "../services/bible-updates.ts";

/**
 * bibleUpdateService has minimal behavior worth unit-testing
 * beyond the DB orchestration (which lives in integration tests).
 * The interesting bits are:
 *
 *   - rejects non-proposal work products with a 422-style error
 *   - rejects an already-applied proposal
 *   - rejects a proposal without targetKbPath
 *   - rejects a proposal without any versions
 *   - rejects append/prepend when the KB doc does not yet exist
 *   - happy-path replace that creates a new KB doc
 *   - happy-path replace that updates an existing KB doc
 *   - happy-path append appends with a blank-line separator
 *   - flips the proposal to status=applied, bypassing pass-criteria
 *
 * We stub contentWorkProductService and knowledgeBaseService via
 * module mocks so each test controls exactly what the orchestrator
 * sees. The real DB never runs here.
 */

const mockWp = vi.hoisted(() => ({
  getWithLatest: vi.fn(),
  update: vi.fn(),
}));
const mockKb = vi.hoisted(() => ({
  getByPath: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/content-work-products.js", () => ({
  contentWorkProductService: () => mockWp,
}));
vi.mock("../services/knowledge-base.js", () => ({
  knowledgeBaseService: () => mockKb,
}));

function makeProposal(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "prop-1",
    type: BIBLE_UPDATE_PROPOSAL_TYPE,
    status: "in_review",
    title: "Elena — new voice sample",
    metadata: {
      targetKbPath: "characters/elena.md",
      applyMode: "replace",
    },
    latestVersion: {
      versionNumber: 2,
      body: "# Elena (revised)\n\nNew voice sample here.",
    },
    ...overrides,
  };
}

function resetMocks() {
  for (const f of [mockWp.getWithLatest, mockWp.update, mockKb.getByPath, mockKb.create, mockKb.update]) {
    f.mockReset();
  }
}

describe("bibleUpdateService", () => {
  describe("applyBibleUpdate rejection paths", () => {
    it("rejects when the work product is not a bible proposal", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue({
        ...makeProposal(),
        type: "novel_chapter",
      });
      const svc = bibleUpdateService({} as never);
      await expect(
        svc.applyBibleUpdate("c1", "prop-1", { userId: "u1", agentId: null }),
      ).rejects.toThrow(/not a bible_update_proposal/);
    });

    it("rejects an already-applied proposal", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue({
        ...makeProposal(),
        status: "applied",
      });
      const svc = bibleUpdateService({} as never);
      await expect(
        svc.applyBibleUpdate("c1", "prop-1", { userId: "u1", agentId: null }),
      ).rejects.toThrow(/already been applied/);
    });

    it("rejects a proposal with no targetKbPath", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue({
        ...makeProposal(),
        metadata: {},
      });
      const svc = bibleUpdateService({} as never);
      await expect(
        svc.applyBibleUpdate("c1", "prop-1", { userId: "u1", agentId: null }),
      ).rejects.toThrow(/targetKbPath/);
    });

    it("rejects a proposal that has no versions yet", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue({
        ...makeProposal(),
        latestVersion: null,
      });
      const svc = bibleUpdateService({} as never);
      await expect(
        svc.applyBibleUpdate("c1", "prop-1", { userId: "u1", agentId: null }),
      ).rejects.toThrow(/no content/);
    });

    it("rejects append/prepend into a non-existent KB doc", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue(
        makeProposal({ metadata: { targetKbPath: "x.md", applyMode: "append" } }),
      );
      mockKb.getByPath.mockResolvedValue(null);
      const svc = bibleUpdateService({} as never);
      await expect(
        svc.applyBibleUpdate("c1", "prop-1", { userId: "u1", agentId: null }),
      ).rejects.toThrow(/non-existent/);
    });
  });

  describe("applyBibleUpdate happy paths", () => {
    it("creates the KB doc when missing and applyMode is replace", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue(makeProposal());
      mockKb.getByPath.mockResolvedValue(null);
      mockKb.create.mockResolvedValue({ id: "kb-1" });
      mockWp.update.mockResolvedValue({ id: "prop-1", status: "applied" });

      const svc = bibleUpdateService({} as never);
      const result = await svc.applyBibleUpdate("c1", "prop-1", {
        userId: "u1",
        agentId: null,
      });
      expect(result.created).toBe(true);
      expect(result.kbDocumentId).toBe("kb-1");
      expect(mockKb.create).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({
          path: "characters/elena.md",
          body: "# Elena (revised)\n\nNew voice sample here.",
        }),
        expect.anything(),
      );
      expect(mockWp.update).toHaveBeenCalledWith(
        "c1",
        "prop-1",
        { status: "applied" },
        expect.anything(),
        { bypass: true },
      );
    });

    it("updates an existing KB doc wholesale on applyMode=replace", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue(makeProposal());
      mockKb.getByPath.mockResolvedValue({
        id: "kb-1",
        body: "# Elena (old)\n\nOld voice sample.",
      });
      mockKb.update.mockResolvedValue({ id: "kb-1" });
      mockWp.update.mockResolvedValue({ id: "prop-1", status: "applied" });

      const svc = bibleUpdateService({} as never);
      const result = await svc.applyBibleUpdate("c1", "prop-1", {
        userId: "u1",
        agentId: null,
      });
      expect(result.created).toBe(false);
      expect(mockKb.update).toHaveBeenCalledWith(
        "c1",
        "kb-1",
        { body: "# Elena (revised)\n\nNew voice sample here." },
        expect.anything(),
      );
    });

    it("appends with a blank line when applyMode=append", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue(
        makeProposal({
          metadata: { targetKbPath: "world/factions.md", applyMode: "append" },
          latestVersion: { versionNumber: 1, body: "## New Faction\n\nThe Verge." },
        }),
      );
      mockKb.getByPath.mockResolvedValue({
        id: "kb-2",
        body: "# Factions\n\n## Old Faction\n\nThe Shard.",
      });
      mockKb.update.mockResolvedValue({ id: "kb-2" });
      mockWp.update.mockResolvedValue({ id: "prop-1", status: "applied" });

      const svc = bibleUpdateService({} as never);
      await svc.applyBibleUpdate("c1", "prop-1", { userId: "u1", agentId: null });
      const body = (mockKb.update.mock.calls[0]![2] as { body: string }).body;
      expect(body).toContain("Old Faction");
      expect(body).toContain("New Faction");
      expect(body).toMatch(/Old Faction[\s\S]*New Faction/);
      // Separator: a blank line between the existing and incoming content.
      expect(body).toMatch(/Shard\.\n\n## New Faction/);
    });

    it("prepends with a blank line when applyMode=prepend", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue(
        makeProposal({
          metadata: { targetKbPath: "timeline/act-2.md", applyMode: "prepend" },
          latestVersion: { versionNumber: 1, body: "Editor note: revised chronology." },
        }),
      );
      mockKb.getByPath.mockResolvedValue({
        id: "kb-3",
        body: "# Act II\n\nEvents in order.",
      });
      mockKb.update.mockResolvedValue({ id: "kb-3" });
      mockWp.update.mockResolvedValue({ id: "prop-1", status: "applied" });

      const svc = bibleUpdateService({} as never);
      await svc.applyBibleUpdate("c1", "prop-1", { userId: "u1", agentId: null });
      const body = (mockKb.update.mock.calls[0]![2] as { body: string }).body;
      expect(body.startsWith("Editor note: revised chronology.")).toBe(true);
      expect(body).toMatch(/revised chronology\.\n\n# Act II/);
    });

    it("flips the proposal status to applied with gate bypass", async () => {
      resetMocks();
      mockWp.getWithLatest.mockResolvedValue(makeProposal());
      mockKb.getByPath.mockResolvedValue({ id: "kb-1", body: "" });
      mockKb.update.mockResolvedValue({ id: "kb-1" });
      mockWp.update.mockResolvedValue({ id: "prop-1", status: "applied" });
      const svc = bibleUpdateService({} as never);
      await svc.applyBibleUpdate("c1", "prop-1", { userId: "u1", agentId: null });
      const [, , patch, , gate] = mockWp.update.mock.calls[0]!;
      expect(patch).toEqual({ status: "applied" });
      expect(gate).toEqual({ bypass: true });
    });
  });
});
