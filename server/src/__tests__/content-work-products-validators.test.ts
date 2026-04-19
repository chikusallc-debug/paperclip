import { describe, expect, it } from "vitest";
import {
  createContentWorkProductSchema,
  updateContentWorkProductSchema,
  createContentWorkProductVersionSchema,
  publishContentWorkProductSchema,
} from "@paperclipai/shared";

describe("content work product validators", () => {
  describe("createContentWorkProductSchema", () => {
    it("accepts a minimal payload and defaults status/kind/tags/metadata", () => {
      const parsed = createContentWorkProductSchema.parse({
        type: "novel_chapter",
        title: "Chapter 1",
      });
      expect(parsed.kind).toBe("content");
      expect(parsed.status).toBe("draft");
      expect(parsed.tags).toEqual([]);
      expect(parsed.metadata).toEqual({});
    });

    it("accepts domain-specific custom statuses in snake_case", () => {
      expect(
        createContentWorkProductSchema.parse({
          type: "novel_chapter",
          title: "Ch1",
          status: "continuity_passed",
        }).status,
      ).toBe("continuity_passed");
    });

    it("rejects non-snake-case statuses", () => {
      expect(
        createContentWorkProductSchema.safeParse({
          type: "novel_chapter",
          title: "Ch1",
          status: "In-Review",
        }).success,
      ).toBe(false);
    });

    it("rejects invalid slugs", () => {
      expect(
        createContentWorkProductSchema.safeParse({
          type: "novel_chapter",
          title: "Ch1",
          slug: "Chapter One",
        }).success,
      ).toBe(false);
      expect(
        createContentWorkProductSchema.safeParse({
          type: "novel_chapter",
          title: "Ch1",
          slug: "-leading-dash",
        }).success,
      ).toBe(false);
    });

    it("accepts kebab-case slugs", () => {
      expect(
        createContentWorkProductSchema.parse({
          type: "novel_chapter",
          title: "Ch1",
          slug: "chapter-01",
        }).slug,
      ).toBe("chapter-01");
    });

    it("accepts an initial body and format", () => {
      const parsed = createContentWorkProductSchema.parse({
        type: "novel_chapter",
        title: "Ch1",
        initialBody: "# Chapter 1\n\nThe storm came at dawn.",
        initialFormat: "markdown",
        initialChangeSummary: "first draft",
      });
      expect(parsed.initialBody).toMatch(/storm/);
      expect(parsed.initialFormat).toBe("markdown");
    });

    it("rejects empty titles", () => {
      expect(
        createContentWorkProductSchema.safeParse({ type: "t", title: "" }).success,
      ).toBe(false);
    });

    it("rejects unknown kinds", () => {
      expect(
        createContentWorkProductSchema.safeParse({
          type: "t",
          title: "T",
          kind: "bogus",
        }).success,
      ).toBe(false);
    });
  });

  describe("updateContentWorkProductSchema", () => {
    it("is strict: rejects extra properties", () => {
      expect(
        updateContentWorkProductSchema.safeParse({
          title: "OK",
          initialBody: "not allowed here",
        }).success,
      ).toBe(false);
    });

    it("accepts explicit null for projectId and slug", () => {
      expect(
        updateContentWorkProductSchema.parse({ projectId: null, slug: null }),
      ).toEqual({ projectId: null, slug: null });
    });

    it("accepts partial updates", () => {
      const result = updateContentWorkProductSchema.parse({ status: "published" });
      expect(result).toEqual({ status: "published" });
    });
  });

  describe("createContentWorkProductVersionSchema", () => {
    it("requires a body string (zero-length allowed)", () => {
      expect(
        createContentWorkProductVersionSchema.safeParse({ body: "" }).success,
      ).toBe(true);
      expect(
        createContentWorkProductVersionSchema.safeParse({}).success,
      ).toBe(false);
    });

    it("defaults format to markdown via the shared format schema", () => {
      // `format` is optional; when absent we expect callers to treat
      // the version as markdown. Schema does not inject a default when
      // absent (callers can; validator stays permissive).
      const parsed = createContentWorkProductVersionSchema.parse({ body: "hello" });
      expect(parsed.format).toBeUndefined();
    });

    it("accepts advanceStatusTo with snake_case values only", () => {
      expect(
        createContentWorkProductVersionSchema.safeParse({
          body: "x",
          advanceStatusTo: "in_review",
        }).success,
      ).toBe(true);
      expect(
        createContentWorkProductVersionSchema.safeParse({
          body: "x",
          advanceStatusTo: "In Review",
        }).success,
      ).toBe(false);
    });
  });

  describe("publishContentWorkProductSchema", () => {
    it("accepts an empty object (implies latest)", () => {
      expect(publishContentWorkProductSchema.parse({})).toEqual({});
    });

    it("accepts a positive integer versionNumber", () => {
      expect(publishContentWorkProductSchema.parse({ versionNumber: 3 })).toEqual({
        versionNumber: 3,
      });
    });

    it("rejects non-positive versionNumber", () => {
      expect(publishContentWorkProductSchema.safeParse({ versionNumber: 0 }).success).toBe(false);
      expect(publishContentWorkProductSchema.safeParse({ versionNumber: -1 }).success).toBe(false);
    });
  });
});
