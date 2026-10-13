import { describe, expect, it } from "vitest";
import { extractNamedPlaces, factCheck, inCity, sameName } from "../src/factcheck.ts";
import { QlooClient } from "../src/qloo.ts";

describe("extractNamedPlaces", () => {
  it("reads numbered, bold and dashed lists", () => {
    const text = "Here you go:\n1. **Trattoria Uno** – cosy\n2. Bar Due - cocktails\n- Caffè Tre: pastries\nEnjoy!";
    expect(extractNamedPlaces(text)).toEqual(["Trattoria Uno", "Bar Due", "Caffè Tre"]);
  });
});

describe("name and city matching", () => {
  it("matches names ignoring accents, case and extra words", () => {
    expect(sameName("Ratanà", "RATANA")).toBe(true);
    expect(sameName("Ristorante Da Gino", "Da Gino")).toBe(true);
    expect(sameName("Jazz Cafe", "Osteria Japo-Jazz")).toBe(false);
  });
  it("knows local city names", () => {
    expect(inCity({ id: "1", name: "x", address: "Via Roma 1, 20100 Milano MI Italy" }, "Milan")).toBe(true);
    expect(inCity({ id: "1", name: "x", city: "Modena" }, "Milan")).toBe(false);
  });
});

describe("factCheck", () => {
  it("labels places in the city, elsewhere, missing and over budget", async () => {
    const places: Record<string, unknown[]> = {
      "Bar Uno": [{ entity_id: "1", name: "Bar Uno", properties: { geocode: { city: "Milan" }, price_level: 4 } }],
      "Osteria Due": [{ entity_id: "2", name: "Osteria Due", properties: { geocode: { city: "Modena" } } }],
      "Invented": [{ entity_id: "3", name: "Something Else", properties: {} }],
    };
    const fetchImpl = (async (url: string) =>
      new Response(JSON.stringify({ results: places[new URL(url).searchParams.get("query")!] ?? [] }))) as typeof fetch;
    const qloo = new QlooClient("k", "https://qloo.test", fetchImpl, 1000, 0, 1);
    const claims = await factCheck(qloo, ["Bar Uno", "Osteria Due", "Invented"], "Milan", 40);
    expect(claims.map((c) => [c.named, c.verdict, c.overBudget])).toEqual([
      ["Bar Uno", "in-city", true],
      ["Osteria Due", "other-city", undefined],
      ["Invented", "not-found", undefined],
    ]);
  });
});
