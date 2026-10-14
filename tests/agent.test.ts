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

  it("falls back to coordinates when Qloo cannot resolve a small town", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      seen.push(url);
      if (u.pathname === "/search") return new Response(JSON.stringify({ results: [{ entity_id: `id-${u.searchParams.get("query")}`, name: "x", types: ["urn:entity:artist"] }] }));
      if (u.searchParams.has("filter.location.query")) return new Response(JSON.stringify({ errors: [{ message: "filter.location.query is unable to resolve to a valid locality." }] }), { status: 400 });
      return new Response(JSON.stringify({ success: true, results: { entities: VENUES } }));
    }) as typeof fetch;
    const qloo = new QlooClient("k", "https://qloo.test", fetchImpl, 1000, 0, 1);
    const agent = new TasteAgent(qloo, offlineLlm, async () => ({ lat: 41.2, lon: 16.6, label: "Molfetta, Bari" }));
    const req = { ...request, city: "Molfetta" };
    const r = await agent.resolve(req.members);
    const k = await agent.rank(req, r.members);
    expect(k.picks.length).toBeGreaterThan(0);
    expect(k.trace[0].detail).toMatch(/within 12 km of Molfetta/);
    expect(seen.some((u) => u.includes("POINT"))).toBe(true);
  });

  it("explains when a town cannot be found at all", async () => {
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/search") return new Response(JSON.stringify({ results: [{ entity_id: "id-x", name: "x", types: ["urn:entity:artist"] }] }));
      return new Response(JSON.stringify({ errors: [{ message: "unable to resolve to a valid locality" }] }), { status: 400 });
    }) as typeof fetch;
    const agent = new TasteAgent(new QlooClient("k", "https://qloo.test", fetchImpl, 1000, 0, 1), offlineLlm, async () => null);
    const r = await agent.resolve(request.members);
    await expect(agent.rank({ ...request, city: "Nowhereville" }, r.members)).rejects.toThrow(/could not find "Nowhereville"/);
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
    expect(keeper()([c("La Pineta Ricevimenti", 0.95), c("Trattoria", 0.95)]).map((x) => x.id)).toEqual(["Trattoria"]);
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

describe("matchExplained", () => {
  const pick = (id: string, name: string) => ({ candidate: { id, name } }) as never;
  const picks = [pick("p1", "Il Cestino"), pick("p2", "Gino's 1928"), pick("p3", "Taverna del Borgo Antico")];

  it("matches by id, then by name, and skips empty answers", async () => {
    const { matchExplained } = await import("../src/agent.ts");
    const got = matchExplained(
      [
        { id: "p1", why: "a" },
        { id: "Gino's 1928", why: "b" },
        { name: "taverna del borgo antico", why: "c" },
        { id: "p1", why: "duplicate" },
        { id: "nowhere", why: "x" },
        { id: "p2", why: "  " },
      ],
      picks,
    );
    expect([...got.keys()]).toEqual(["p1", "p2", "p3"]);
    expect(got.get("p1")?.why).toBe("a");
  });

  it("reports a partial answer so the next model can be tried", async () => {
    const { matchExplained } = await import("../src/agent.ts");
    expect(matchExplained([{ id: "p3", why: "only one" }], picks).size).toBe(1);
    expect(matchExplained(undefined, picks).size).toBe(0);
  });
});
