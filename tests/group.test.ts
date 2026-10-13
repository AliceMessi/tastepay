import { describe, expect, it } from "vitest";
import { distinctiveSharedTags, isRealName, maxPriceLevel, rankGroup } from "../src/group.ts";
import type { Candidate } from "../src/qloo.ts";

// Synthetic fixtures only: Qloo response data must not be committed.
const tag = (name: string, type = "urn:tag:ambience:qloo") => ({ id: `t:${name}`, name, type });
const place = (id: string, affinity: number, extra: Partial<Candidate> = {}): Candidate => ({ id, name: `Place ${id}`, affinity, tags: [], ...extra });

describe("rankGroup", () => {
  it("prefers the place nobody dislikes over one person's favourite", () => {
    const members = [
      { member: "A", picks: [place("x", 0.99), place("y", 0.8)] },
      { member: "B", picks: [place("y", 0.82), place("x", 0.4)] },
    ];
    const [best] = rankGroup(members, []);
    expect(best.candidate.id).toBe("y");
    expect(best.perMember.map((p) => p.member)).toEqual(["A", "B"]);
  });

  it("estimates a missing score below the member's lowest known one", () => {
    const members = [
      { member: "A", picks: [place("x", 0.9), place("z", 0.6)] },
      { member: "B", picks: [place("x", 0.7)] },
    ];
    const z = rankGroup(members, [], { top: 5 }).find((p) => p.candidate.id === "z")!;
    const b = z.perMember.find((p) => p.member === "B")!;
    expect(b.known).toBe(false);
    expect(b.score).toBeCloseTo(0.63);
  });

  it("drops places over budget, closed places and locality names", () => {
    const members = [{ member: "A", picks: [place("cheap", 0.7, { priceLevel: 2 }), place("dear", 0.95, { priceLevel: 4 }), place("shut", 0.99, { closed: true }), place("m", 0.99, { name: "milano" })] }, { member: "B", picks: [] }];
    const ids = rankGroup(members, [], { budgetPerPerson: 30, top: 5, city: "Milan" }).map((p) => p.candidate.id);
    expect(ids).toEqual(["cheap"]);
  });

  it("returns nothing for an empty group", () => {
    expect(rankGroup([], [place("x", 1)])).toEqual([]);
  });
});

describe("distinctiveSharedTags", () => {
  it("keeps vibe tags shared by two members, rarest first, without duplicates or generic ones", () => {
    const c = place("x", 1, { tags: [tag("Cinematic"), tag("Cozy"), tag("Restaurant", "urn:tag:genre:place"), tag("Cinematic", "urn:tag:decor:qloo"), tag("Payments", "urn:tag:payments:place")] });
    const m1 = new Map([["t:Cinematic", 1], ["t:Cozy", 1], ["t:Restaurant", 1]]);
    const m2 = new Map([["t:Cinematic", 2], ["t:Cozy", 1], ["t:Restaurant", 1]]);
    const df = new Map([["t:Cinematic", 1], ["t:Cozy", 9]]);
    expect(distinctiveSharedTags(c, [m1, m2], df, 10).map((t) => t.name)).toEqual(["Cinematic", "Cozy"]);
  });
});

describe("helpers", () => {
  it("maps budgets to Qloo price levels", () => {
    expect([10, 30, 60, 150].map(maxPriceLevel)).toEqual([1, 2, 3, 4]);
  });
  it("rejects locality names", () => {
    expect(isRealName("milano", "Milan")).toBe(false);
    expect(isRealName("Bar Centrale", "Milan")).toBe(true);
  });
});
