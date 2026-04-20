import { describe, expect, it } from "vitest";
import { interpolateTemplate } from "../services/content-templates.ts";

describe("interpolateTemplate", () => {
  it("substitutes simple variables", () => {
    expect(interpolateTemplate("Chapter {{n}}: {{title}}", { n: "12", title: "Arrival" })).toBe(
      "Chapter 12: Arrival",
    );
  });

  it("coerces numbers", () => {
    expect(interpolateTemplate("Chapter {{n}}", { n: 12 })).toBe("Chapter 12");
  });

  it("renders missing variables as empty string (forgiving)", () => {
    expect(interpolateTemplate("Chapter {{n}}: {{title}}", { n: 12 })).toBe("Chapter 12: ");
  });

  it("ignores unrelated braces", () => {
    expect(interpolateTemplate("Pre { text } {x}", {})).toBe("Pre { text } {x}");
  });

  it("tolerates whitespace inside the placeholder", () => {
    expect(interpolateTemplate("X = {{   value   }}", { value: "ok" })).toBe("X = ok");
  });

  it("does not process nested placeholders", () => {
    // Agent-authored templates must stay auditable — nested lookups
    // would invite injection games. `{{ {{inner}} }}` should remain
    // literal after the inner replacement.
    expect(interpolateTemplate("{{{{inner}}}}", { inner: "value" })).toBe("{{value}}");
  });

  it("ignores invalid identifiers", () => {
    expect(interpolateTemplate("{{ bad-name }}", { "bad-name": "x" })).toBe("{{ bad-name }}");
    expect(interpolateTemplate("{{1invalid}}", { "1invalid": "x" })).toBe("{{1invalid}}");
  });
});
