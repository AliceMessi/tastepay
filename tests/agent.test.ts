import { describe, expect, it } from "vitest";
import { parseBrief, TasteAgent, validateRequest } from "../src/agent.ts";
import { extractJson, LlmClient } from "../src/llm.ts";
import { QlooClient } from "../src/qloo.ts";

// A fake Qloo that answers from synthetic data, keyed by endpoint.
function fakeQloo(calls: string[] = []) {
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const body = u.pathname === "/search"
      ? { results: [{ entity_id: `id-${u.searchParams.get("query")}`, name: u.searchParams.get("query"), types: ["urn:entity:artist"] }] }
      : { success: true, results: { entities: [1, 2, 3].map((i) => ({ entity_id: `p${i}`, name: `Venue ${i}`, query: { affinity: 0.9 - i / 10 }, tags: [], properties: {} })) } };
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

  it("returns no baseline when no model is available", async () => {
    const b = await new TasteAgent(fakeQloo(), offlineLlm).baseline(request);
    expect(b.text).toBeNull();
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
