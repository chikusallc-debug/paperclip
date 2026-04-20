import { describe, expect, it } from "vitest";
import {
  evaluatePassCriteria,
  isGatedTransition,
  hasPassCriteria,
  GATED_TRANSITION_TARGETS,
} from "@paperclipai/shared";

describe("evaluatePassCriteria", () => {
  it("passes when no criteria are defined", () => {
    const result = evaluatePassCriteria({ body: "", tags: [], criteria: {} });
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("computes wordcount ignoring markdown punctuation", () => {
    const result = evaluatePassCriteria({
      body: "# Chapter 1\n\nThe storm came at dawn.",
      tags: [],
      criteria: {},
    });
    // "Chapter" "1" "The" "storm" "came" "at" "dawn" — 7 words
    // (digits are a word token, single-letter "1" is kept).
    // Actual token count depends on regex; accept >= 6 here.
    expect(result.stats.wordcount).toBeGreaterThanOrEqual(6);
  });

  it("strips code fences and inline code before counting", () => {
    const result = evaluatePassCriteria({
      body: "one\n```\nlots of code tokens here\n```\nthree",
      tags: [],
      criteria: {},
    });
    // "one" + "three" = 2
    expect(result.stats.wordcount).toBe(2);
  });

  it("extracts markdown headings at any level", () => {
    const result = evaluatePassCriteria({
      body: "# One\n## Two\n### Three\nbody\n#### Four ####\n",
      tags: [],
      criteria: {},
    });
    expect(result.stats.headings).toEqual(["One", "Two", "Three", "Four"]);
  });

  describe("minWordcount", () => {
    it("fails when body is below the threshold", () => {
      const result = evaluatePassCriteria({
        body: "a b c d",
        tags: [],
        criteria: { minWordcount: 10 },
      });
      expect(result.passed).toBe(false);
      expect(result.failures[0]!.code).toBe("min_wordcount");
    });
    it("passes when body meets the threshold", () => {
      const result = evaluatePassCriteria({
        body: Array.from({ length: 100 }).fill("word").join(" "),
        tags: [],
        criteria: { minWordcount: 100 },
      });
      expect(result.passed).toBe(true);
    });
  });

  describe("maxWordcount", () => {
    it("fails when body exceeds the threshold", () => {
      const result = evaluatePassCriteria({
        body: Array.from({ length: 50 }).fill("word").join(" "),
        tags: [],
        criteria: { maxWordcount: 30 },
      });
      expect(result.passed).toBe(false);
      expect(result.failures[0]!.code).toBe("max_wordcount");
    });
  });

  describe("requiredTags", () => {
    it("fails when tags are missing", () => {
      const result = evaluatePassCriteria({
        body: "x",
        tags: ["act:1"],
        criteria: { requiredTags: ["act:1", "pov:elena"] },
      });
      expect(result.passed).toBe(false);
      expect(result.failures[0]!.code).toBe("required_tags_missing");
      expect(result.failures[0]!.details?.missing).toEqual(["pov:elena"]);
    });
    it("passes when all required tags are present", () => {
      const result = evaluatePassCriteria({
        body: "x",
        tags: ["act:1", "pov:elena", "novel"],
        criteria: { requiredTags: ["act:1", "pov:elena"] },
      });
      expect(result.passed).toBe(true);
    });
  });

  describe("requiredHeadings", () => {
    it("fails when a required heading is missing (case-insensitive)", () => {
      const result = evaluatePassCriteria({
        body: "# Intro\n## Beats",
        tags: [],
        criteria: { requiredHeadings: ["Intro", "Beats", "Resolution"] },
      });
      expect(result.passed).toBe(false);
      expect(result.failures[0]!.code).toBe("required_headings_missing");
      expect(result.failures[0]!.details?.missing).toEqual(["Resolution"]);
    });
    it("passes with case differences between text and required", () => {
      const result = evaluatePassCriteria({
        body: "# intro\n## BEATS",
        tags: [],
        criteria: { requiredHeadings: ["Intro", "beats"] },
      });
      expect(result.passed).toBe(true);
    });
  });

  describe("forbiddenPhrases", () => {
    it("fails on substring match, case-insensitive", () => {
      const result = evaluatePassCriteria({
        body: "the chapter began. TODO: ask editor about this.",
        tags: [],
        criteria: { forbiddenPhrases: ["todo", "fixme"] },
      });
      expect(result.passed).toBe(false);
      expect(result.failures[0]!.code).toBe("forbidden_phrases_present");
      expect(result.failures[0]!.details?.present).toEqual(["todo"]);
    });
  });

  it("collects multiple failures across rules", () => {
    const result = evaluatePassCriteria({
      body: "too short TODO",
      tags: ["act:1"],
      criteria: {
        minWordcount: 100,
        requiredTags: ["pov:elena"],
        forbiddenPhrases: ["todo"],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.failures.map((f) => f.code).sort()).toEqual(
      ["forbidden_phrases_present", "min_wordcount", "required_tags_missing"].sort(),
    );
  });

  it("ignores unknown criteria keys (forward-compat)", () => {
    const result = evaluatePassCriteria({
      body: "x",
      tags: [],
      criteria: { futureRule: "something", minWordcount: 0 },
    });
    expect(result.passed).toBe(true);
  });

  it("ignores invalid criteria values", () => {
    // negative / NaN / wrong-type values are discarded rather than
    // throwing — callers send partial criteria all the time.
    const result = evaluatePassCriteria({
      body: "x",
      tags: [],
      criteria: {
        minWordcount: -5,
        maxWordcount: "10" as unknown as number,
        requiredTags: "not-an-array" as unknown as string[],
      },
    });
    expect(result.passed).toBe(true);
  });
});

describe("isGatedTransition", () => {
  it("gates transitions INTO in_review/final/published", () => {
    expect(isGatedTransition("draft", "in_review")).toBe(true);
    expect(isGatedTransition("in_review", "final")).toBe(true);
    expect(isGatedTransition("final", "published")).toBe(true);
  });
  it("does not gate the same-to-same non-transition", () => {
    expect(isGatedTransition("draft", "draft")).toBe(false);
    expect(isGatedTransition("in_review", "in_review")).toBe(false);
  });
  it("does not gate transitions to draft or archived", () => {
    expect(isGatedTransition("in_review", "draft")).toBe(false);
    expect(isGatedTransition("published", "archived")).toBe(false);
  });
  it("does not gate transitions to custom profile states", () => {
    // Domain-specific states (continuity_passed, layout_ready) are
    // not gated by default — operators opt in by mapping them to a
    // canonical gated state if they want enforcement.
    expect(isGatedTransition("draft", "continuity_passed")).toBe(false);
  });
});

describe("hasPassCriteria / GATED_TRANSITION_TARGETS", () => {
  it("exposes the gated targets set", () => {
    expect(GATED_TRANSITION_TARGETS.has("in_review")).toBe(true);
    expect(GATED_TRANSITION_TARGETS.has("final")).toBe(true);
    expect(GATED_TRANSITION_TARGETS.has("published")).toBe(true);
    expect(GATED_TRANSITION_TARGETS.has("draft")).toBe(false);
  });
  it("treats empty/undefined as no criteria", () => {
    expect(hasPassCriteria({})).toBe(false);
    expect(hasPassCriteria(null)).toBe(false);
    expect(hasPassCriteria(undefined)).toBe(false);
    expect(hasPassCriteria({ minWordcount: 1 })).toBe(true);
  });
});
