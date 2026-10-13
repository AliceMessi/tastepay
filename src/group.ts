// Group fit: turn each person's Qloo affinities into one fair ranking.

import type { Candidate, Tag } from "./qloo.ts";

export interface MemberScores {
  member: string;
  picks: Candidate[];
}

export interface GroupPick {
  candidate: Candidate;
  fit: number;
  perMember: { member: string; score: number; known: boolean }[];
  sharedTags: Tag[];
}

// Tag families that describe a place's character (what a group can agree on).
const VIBE_TYPES = ["ambience", "decor", "interests", "cuisine", "atmosphere", "style", "neighborhood_characteristic", "genre:destination"];
const TOO_GENERIC = new Set(["place", "restaurant", "food", "bar", "cafe", "alcohol", "touristic", "walkable", "central"]);

export function isVibeTag(tag: Tag): boolean {
  return VIBE_TYPES.some((t) => tag.type.includes(t)) && !TOO_GENERIC.has(tag.name.toLowerCase());
}

/** Highest price_level (1–4) that fits a budget per person in EUR. */
export function maxPriceLevel(budgetPerPerson: number): number {
  if (budgetPerPerson <= 15) return 1;
  if (budgetPerPerson <= 35) return 2;
  if (budgetPerPerson <= 70) return 3;
  return 4;
}

/**
 * Score every candidate for every member. A candidate missing from a member's
 * list gets a score just below that member's lowest known affinity, so it can
 * still rank but never beats an explicit match.
 */
export function rankGroup(
  members: MemberScores[],
  pool: Candidate[],
  opts: { budgetPerPerson?: number; minRating?: number; top?: number; city?: string } = {},
): GroupPick[] {
  if (members.length === 0) return [];
  const byId = new Map<string, Candidate>();
  for (const c of [...pool, ...members.flatMap((m) => m.picks)]) if (!byId.has(c.id)) byId.set(c.id, c);

  const maxLevel = opts.budgetPerPerson ? maxPriceLevel(opts.budgetPerPerson) : 4;
  const memberMaps = members.map((m) => ({
    member: m.member,
    scores: new Map(m.picks.map((c) => [c.id, c.affinity])),
    floor: m.picks.length ? Math.min(...m.picks.map((c) => c.affinity)) * 0.9 : 0,
    tags: tagCounts(m.picks.slice(0, 15)),
  }));

  // How common each tag is in the pool, so a shared rare tag says more than a common one.
  const all = [...byId.values()];
  const df = tagCounts(all);

  const picks: GroupPick[] = [];
  for (const c of all) {
    if (c.closed) continue;
    if (!isRealName(c.name, opts.city)) continue;
    if (c.priceLevel && c.priceLevel > maxLevel) continue;
    if (opts.minRating && c.rating && c.rating < opts.minRating) continue;
    const perMember = memberMaps.map((m) => {
      const s = m.scores.get(c.id);
      return { member: m.member, score: s ?? m.floor, known: s !== undefined };
    });
    const scores = perMember.map((p) => p.score);
    const fit = 0.6 * Math.min(...scores) + 0.4 * mean(scores);
    const sharedTags = distinctiveSharedTags(c, memberMaps.map((m) => m.tags), df, all.length);
    picks.push({ candidate: c, fit, perMember, sharedTags });
  }
  picks.sort((a, b) => b.fit - a.fit || b.perMember.filter((p) => p.known).length - a.perMember.filter((p) => p.known).length);
  return picks.slice(0, opts.top ?? 3);
}

/** Vibe tags of `c` that at least two members' own top picks also carry, rarest first, no duplicates. */
export function distinctiveSharedTags(c: Candidate, memberTags: Map<string, number>[], df: Map<string, number>, poolSize: number, max = 4): Tag[] {
  const need = Math.min(2, memberTags.length);
  const seen = new Set<string>();
  return c.tags
    .filter((t) => isVibeTag(t) && memberTags.filter((m) => (m.get(t.id) ?? 0) > 0).length >= need)
    .map((t) => ({ t, w: memberTags.filter((m) => m.has(t.id)).length * Math.log((poolSize + 1) / (df.get(t.id) ?? 1)) }))
    .sort((a, b) => b.w - a.w)
    .filter(({ t }) => !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase()))
    .slice(0, max)
    .map(({ t }) => t);
}

/** Qloo sometimes returns a locality-named entity ("milano"); it is not a venue. */
export function isRealName(name: string, city?: string): boolean {
  const n = name.trim().toLowerCase();
  if (n.length < 3) return false;
  if (!city) return true;
  const c = city.trim().toLowerCase();
  return n !== c && n !== ({ milan: "milano", rome: "roma", florence: "firenze", turin: "torino", naples: "napoli", venice: "venezia" } as Record<string, string>)[c];
}

function tagCounts(cands: Candidate[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cands) for (const t of c.tags) m.set(t.id, (m.get(t.id) ?? 0) + 1);
  return m;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
