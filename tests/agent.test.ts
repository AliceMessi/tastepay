import { describe, expect, it } from "vitest";
import { parseBrief, TasteAgent, validateRequest } from "../src/agent.ts";
import { extractJson, LlmClient } from "../src/llm.ts";
import { QlooClient } from "../src/qloo.ts";

// A fake Qloo that answers from synthetic data, keyed by endpoint.
const genre = (g: string) => ({ primary_genre: { id: `urn:tag:genre:place:${g}` } });
const VENUES = [
  { entity_id: "p1", name: "Venue 1", query: { affinity: 0.8 }, tags: [], properties: genre("restaurant:italian") },
  { entity_id: "p2", name: "Venue 2", query: { affinity: 0.7 }, tags: [], properties: genre("restaurant") },
  { entity_id: "mall", name: "Big Mall", query: { affinity: 0.95 }, tags: [], properties: genre("shopping_mall") },
  { entity_id: "cafe", name: "Corner Cafe", query: { affinity: 0.9 }, tags: [], properties: genre("restaurant:cafe") },
];

function fakeQloo(calls: string[] = [], failInsights = 0) {
  let insightCalls = 0;
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname !== "/search" && insightCalls++ < failInsights) return new Response("{}", { status: 429 });
    const body = u.pathname === "/search"
      ? { results: [{ entity_id: `id-${u.searchParams.get("query")}`, name: u.searchParams.get("query"), types: ["urn:entity:artist"] }] }
      : { success: true, results: { entities: VENUES } };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return new QlooClient("test-key", "https://qloo.test", fetchImpl, 1000, 0, 1);
}

const offlineLlm = new LlmClient(undefined);
const request = { occasion: "dinner" as const, city: "Milan", budgetPerPerson: 40, members: [{ name: "Sara", favourites: ["Radiohead"] }, { name: "Luca", favourites: ["Miles Davis"] }] };

describe("TasteAgent without any LLM", () => {
  it("runs resolve → rank → explain with the deterministic path", async () => {
    const calls: string[] = [];
    const agent = new TasteAgent(fakeQloo(calls), offlineLlm);
    const r = await agent.resolve(request.members);
    expect(r.members.map((m) => m.tastes[0].id)).toEqual(["id-Radiohead", "id-Miles Davis"]);
    const k = await agent.rank(request, r.members);
    expect(k.picks[0].candidate.id).toBe("p1");
    const e = await agent.explain(request, r.members, k.picks);
    expect(e.trace.source).toMatch(/no model/);
    expect(Object.keys(e.explanations)).toHaveLength(k.picks.length);
    expect(calls.every((c) => !c.includes("test-key"))).toBe(true);
  });

  it("sends only taste items and filters to Qloo, never names", async () => {
    const calls: string[] = [];
    const agent = new TasteAgent(fakeQloo(calls), offlineLlm);
    const r = await agent.resolve(request.members);
    await agent.rank(request, r.members);
    expect(calls.some((c) => c.includes("Sara") || c.includes("Luca"))).toBe(false);
  });

  it("keeps only real restaurants for dinner (no malls, no cafes)", async () => {
    const agent = new TasteAgent(fakeQloo(), offlineLlm);
    const r = await agent.resolve(request.members);
    const k = await agent.rank(request, r.members);
    expect(k.picks.map((p) => p.candidate.id)).toEqual(["p1", "p2"]);
  });

  it("still ranks when Qloo rejects one person's request", async () => {
    const agent = new TasteAgent(fakeQloo([], 1), offlineLlm);
    const r = await agent.resolve(request.members);
    const k = await agent.rank(request, r.members);
    expect(k.picks.length).toBeGreaterThan(0);
    expect(k.trace[0].detail).toMatch(/Qloo busy for/);
  });

  it("returns no baseline when no model is available", async () => {
    const b = await new TasteAgent(fakeQloo(), offlineLlm).baseline(request);
    expect(b.text).toBeNull();
  });
});

describe("keeper", () => {
  it("drops little-known places only when enough well-known ones remain", async () => {
    const { keeper } = await import("../src/agent.ts");
    const c = (id: string, popularity: number) => ({ id, name: id, affinity: 0.5, tags: [], popularity, primaryGenre: "urn:tag:genre:place:restaurant" });
    const many = [...Array(6)].map((_, i) => c(`k${i}`, 0.95)).concat([c("obscure", 0.5)]);
    expect(keeper()(many).map((x) => x.id)).not.toContain("obscure");
    expect(keeper()([c("a", 0.95), c("obscure", 0.5)]).map((x) => x.id)).toEqual(["a", "obscure"]);
  });
});

describe("parseBrief", () => {
  it("reads occasion, city, budget and people from a plain brief", () => {
    const r = parseBrief("Team dinner in Milan on Friday, about 40€ each. Sara: Radiohead, Murakami. Luca: Wes Anderson and jazz.");
    expect(r).toMatchObject({ occasion: "dinner", city: "Milan", budgetPerPerson: 40 });
    expect(r.members).toEqual([{ name: "Sara", favourites: ["Radiohead", "Murakami"] }, { name: "Luca", favourites: ["Wes Anderson", "jazz"] }]);
  });
  it("detects drinks and trips", () => {
    expect(parseBrief("Drinks in London. A: x. B: y").occasion).toBe("drinks");
    expect(parseBrief("A weekend trip for us. A: x. B: y").occasion).toBe("trip");
  });
});

describe("validation and parsing helpers", () => {
  it("needs a city for local occasions and two people", () => {
    expect(validateRequest({ ...request, city: "" })).toMatch(/city/);
    expect(validateRequest({ ...request, members: request.members.slice(0, 1) })).toMatch(/two people/);
    expect(validateRequest(request)).toBeNull();
  });
  it("extracts JSON wrapped in prose or fences", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson("no json")).toBeNull();
  });
});

describe("LLM chain config", () => {
  it("uses OPENROUTER_MODELS when set", async () => {
    const { modelsFromEnv, MODEL_CHAIN } = await import("../src/llm.ts");
    expect(modelsFromEnv("a/b, c/d")).toEqual(["a/b", "c/d"]);
    expect(modelsFromEnv(undefined)).toEqual(MODEL_CHAIN);
  });
});
