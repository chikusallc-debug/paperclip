import { describe, expect, it } from "vitest";
import { contentWorkProductService } from "../services/content-work-products.ts";

// Pure helper: no DB calls required. We construct the service just to
// get at the function off the object.
const svc = contentWorkProductService({} as never);

describe("extractContextPackIdsFromMetadata", () => {
  it("returns [] for null / undefined / non-object", () => {
    expect(svc.extractContextPackIdsFromMetadata(null)).toEqual([]);
    expect(svc.extractContextPackIdsFromMetadata(undefined)).toEqual([]);
    expect(svc.extractContextPackIdsFromMetadata({} as Record<string, unknown>)).toEqual([]);
  });

  it("returns [] when metadata has no contextPackIds key", () => {
    expect(
      svc.extractContextPackIdsFromMetadata({ wordcountTarget: 5000 }),
    ).toEqual([]);
  });

  it("returns [] when contextPackIds is not an array", () => {
    expect(
      svc.extractContextPackIdsFromMetadata({ contextPackIds: "bogus" } as Record<string, unknown>),
    ).toEqual([]);
    expect(
      svc.extractContextPackIdsFromMetadata({ contextPackIds: 42 } as Record<string, unknown>),
    ).toEqual([]);
  });

  it("returns only non-empty string entries", () => {
    expect(
      svc.extractContextPackIdsFromMetadata({
        contextPackIds: ["a", "", "b", 42, null, "c"] as unknown as string[],
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("returns a fresh array (does not alias the metadata)", () => {
    const original = ["a", "b"];
    const out = svc.extractContextPackIdsFromMetadata({ contextPackIds: original });
    expect(out).toEqual(["a", "b"]);
    out.push("mutated");
    expect(original).toEqual(["a", "b"]);
  });
});
