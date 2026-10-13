// Check the places an LLM named without taste data against Qloo's place graph.

import { maxPriceLevel } from "./group.ts";
import type { PlaceHit, QlooClient } from "./qloo.ts";

export type Verdict = "in-city" | "other-city" | "not-found";

export interface Claim {
  named: string;
  verdict: Verdict;
  match?: PlaceHit;
  overBudget?: boolean;
}

const CITY_ALIASES: Record<string, string[]> = {
  milan: ["milano"], rome: ["roma"], florence: ["firenze"], turin: ["torino"], naples: ["napoli"], venice: ["venezia"],
  munich: ["münchen"], vienna: ["wien"], geneva: ["genève"], zurich: ["zürich"], lisbon: ["lisboa"],
};

/** Place names an LLM listed, e.g. "1. **Langosteria** – ..." or "2. Ratanà - ...". */
export function extractNamedPlaces(text: string, max = 5): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s*(?:\*\*([^*]+)\*\*|([^–—:\-(]+?))\s*(?:[–—:\-(]|$)/);
    const name = (m?.[1] ?? m?.[2])?.trim().replace(/[*_"]/g, "");
    if (name && name.length >= 3 && name.length <= 60 && !names.includes(name)) names.push(name);
  }
  return names.slice(0, max);
}

export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Same venue if every word of the shorter name is a whole word of the longer one
 * ("Da Gino" ~ "Ristorante Da Gino"), or most words overlap. Partial words do not
 * count: "Ratana" is not "Ratanakorn market".
 */
export function sameName(a: string, b: string): boolean {
  const x = fold(a), y = fold(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const wx = new Set(x.split(" ")), wy = new Set(y.split(" "));
  const [small, big] = wx.size <= wy.size ? [wx, wy] : [wy, wx];
  const common = [...small].filter((w) => big.has(w)).length;
  if (common === small.size && [...small].some((w) => w.length >= 3)) return true;
  return common / Math.max(wx.size, wy.size) >= 0.6;
}

export function inCity(hit: PlaceHit, city?: string): boolean {
  if (!city) return true;
  const c = fold(city);
  const names = [c, ...(CITY_ALIASES[c] ?? []).map(fold)];
  const where = fold(`${hit.city ?? ""} ${hit.address ?? ""}`);
  return names.some((n) => where.includes(n));
}

export async function factCheck(qloo: QlooClient, names: string[], city?: string, budgetPerPerson?: number): Promise<Claim[]> {
  const maxLevel = budgetPerPerson ? maxPriceLevel(budgetPerPerson) : 4;
  const claims: Claim[] = [];
  for (const named of names) {
    const hits = (await qloo.searchPlaces(named).catch(() => [])).filter((h) => sameName(h.name, named));
    const local = hits.find((h) => inCity(h, city));
    const match = local ?? hits[0];
    claims.push({
      named,
      verdict: local ? "in-city" : match ? "other-city" : "not-found",
      match,
      overBudget: match?.priceLevel ? match.priceLevel > maxLevel : undefined,
    });
  }
  return claims;
}
