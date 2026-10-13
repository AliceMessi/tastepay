// The TastePay agent: understand the brief, resolve tastes with Qloo, find what
// fits the whole group, explain it, and show what an LLM alone would have said.
// Each step is a separate call so a serverless function answers within ~10 s.

import { extractJson, LlmClient } from "./llm.ts";
import { rankGroup, type GroupPick, type MemberScores } from "./group.ts";
import { QlooClient, type Candidate, type TasteEntity } from "./qloo.ts";
import { extractNamedPlaces, factCheck, type Claim } from "./factcheck.ts";

export type Occasion = "dinner" | "drinks" | "culture" | "trip";

const G = "urn:tag:genre:place:";
const NOT_DINNER = ["cafe", "coffee", "dessert", "bakery", "ice_cream", "juice", "tea", "donut", "snack"];

export const OCCASIONS: Record<Occasion, { label: string; type: string; tags?: string[]; local: boolean; accept?: (primaryGenre?: string) => boolean }> = {
  // Qloo's tag filter also returns markets, malls and hotels that merely have a
  // restaurant inside; the venue's primary genre says what it really is.
  dinner: {
    label: "dinner", type: "urn:entity:place", tags: [`${G}restaurant`], local: true,
    accept: (g) => !!g?.startsWith(`${G}restaurant`) && !NOT_DINNER.some((x) => g.includes(x)) && !/(bar|pub|tabac)/.test(g.replace(G, "")),
  },
  drinks: {
    label: "drinks", type: "urn:entity:place", tags: [`${G}restaurant:bar`], local: true,
    accept: (g) => !!g && /(bar|pub|brewery|wine|cocktail|lounge|tavern|izakaya)/.test(g.replace(G, "")),
  },
  culture: {
    label: "a culture outing", type: "urn:entity:place", tags: [`${G}museum`, `${G}art_gallery`], local: true,
    accept: (g) => !!g && /(museum|gallery|art|cultural|exhibit|theater|theatre|library)/.test(g.replace(G, "")),
  },
  trip: { label: "a weekend trip", type: "urn:entity:destination", local: false },
};

export interface MemberInput {
  name: string;
  favourites: string[];
}

export interface PlanRequest {
  occasion: Occasion;
  city?: string;
  budgetPerPerson?: number;
  members: MemberInput[];
}

export interface ResolvedTaste extends TasteEntity {
  query: string;
  alternatives: TasteEntity[];
}

export interface ResolvedMember {
  name: string;
  tastes: ResolvedTaste[];
}

export interface TraceStep {
  step: string;
  detail: string;
  source: string;
  ms: number;
}

export interface Explanation {
  why: string;
  perMember: Record<string, string>;
}

export const MAX_MEMBERS = 8;

export class QlooBusyError extends Error {
  constructor() {
    super("Qloo is busy right now. Please try again in a few seconds.");
  }
}
export const MAX_FAVOURITES = 3;

export function validateRequest(r: PlanRequest): string | null {
  if (!r || !OCCASIONS[r.occasion]) return "Unknown occasion";
  if (OCCASIONS[r.occasion].local && !r.city?.trim()) return "A city is needed for this occasion";
  const members = activeMembers(r.members ?? []);
  if (members.length < 2) return "Add at least two people with at least one favourite each";
  if (members.length > MAX_MEMBERS) return `At most ${MAX_MEMBERS} people`;
  return null;
}

export function activeMembers(members: MemberInput[]): MemberInput[] {
  return members
    .map((m) => ({
      name: (m.name || "").trim().slice(0, 30),
      favourites: (m.favourites ?? []).map((f) => String(f).trim().slice(0, 80)).filter(Boolean).slice(0, MAX_FAVOURITES),
    }))
    .filter((m) => m.name && m.favourites.length);
}

export class TasteAgent {
  constructor(private qloo: QlooClient, private llm: LlmClient) {}

  /** Step 0 (optional): turn a free-text brief into a structured plan. */
  async understand(brief: string): Promise<{ request: PlanRequest; trace: TraceStep }> {
    const t = Date.now();
    const res = await this.llm.chat([
      {
        role: "system",
        content:
          "Extract a group plan from the user's message. Reply with JSON only: " +
          '{"occasion":"dinner|drinks|culture|trip","city":"...","budgetPerPerson":number|null,"members":[{"name":"...","favourites":["..."]}]}. ' +
          "Favourites are things a person loves (artists, films, books, shows, brands). Keep names exactly as written. Do not add people or favourites.",
      },
      { role: "user", content: brief.slice(0, 1500) },
    ], undefined, 700, 8_500, (c) => extractJson(c) !== null);
    const parsed = extractJson<PlanRequest>(res?.message.content);
    if (parsed && !validateRequest(parsed)) {
      const request = normalise(parsed);
      return { request, trace: { step: "Understand brief", source: `LLM ${res!.model}`, detail: summary(request), ms: Date.now() - t } };
    }
    const request = parseBrief(brief);
    return { request, trace: { step: "Understand brief", source: "rules (no model answered)", detail: summary(request), ms: Date.now() - t } };
  }

  /** Step 1: map each favourite to a Qloo entity, keeping alternatives for the UI. */
  async resolve(members: MemberInput[]): Promise<{ members: ResolvedMember[]; trace: TraceStep }> {
    const t = Date.now();
    const out = await mapLimit(activeMembers(members), 2, async (m) => ({
      name: m.name,
      tastes: (
        await Promise.all(
          m.favourites.map(async (query) => {
            const hits = await this.qloo.search(query).catch(() => []);
            const alternatives = hits.slice(1).filter((h, i, all) => h.id !== hits[0].id && all.findIndex((x) => x.id === h.id) === i).slice(0, 3);
            return hits.length ? { ...hits[0], query, alternatives } : null;
          }),
        )
      ).filter((x): x is ResolvedTaste => x !== null),
    }));
    return {
      members: out,
      trace: {
        step: "Resolve tastes",
        source: "Qloo /search",
        detail: out.map((m) => `${m.name}: ${m.tastes.map((x) => `${x.name} (${shortType(x.type)})`).join(", ") || "nothing found"}`).join(" · "),
        ms: Date.now() - t,
      },
    };
  }

  /** Step 2: each person's affinities in the target domain, then a fair group ranking. */
  async rank(req: PlanRequest, members: ResolvedMember[]): Promise<{ picks: GroupPick[]; trace: TraceStep[] }> {
    const occasion = OCCASIONS[req.occasion];
    const withTastes = members.filter((m) => m.tastes.length).slice(0, MAX_MEMBERS);
    const base = { type: occasion.type, location: occasion.local ? req.city : undefined, tags: occasion.tags };
    const t = Date.now();
    // At most two Qloo calls in flight (bursts get HTTP 429). One person's list
    // failing does not sink the plan: they are scored from the others' data.
    const groupIds = withTastes.flatMap((m) => m.tastes.map((x) => x.id));
    const jobs = [
      ...withTastes.map((m) => ({ member: m.name as string | null, ids: m.tastes.map((x) => x.id), page: 1 })),
      // The group signal gets two pages: after the genre filter one page can be thin.
      { member: null as string | null, ids: groupIds, page: 1 },
      { member: null as string | null, ids: groupIds, page: 2 },
    ];
    const lists = await mapLimit(jobs, 2, async (j) => ({ ...j, picks: await this.qloo.insights({ ...base, entityIds: j.ids, page: j.page }).catch(() => null) }));
    const keep = keeper(occasion.accept);
    const perMember: MemberScores[] = lists.filter((l) => l.member && l.picks).map((l) => ({ member: l.member!, picks: keep(l.picks!) }));
    const pool = keep(lists.filter((l) => l.member === null).flatMap((l) => l.picks ?? []));
    if (!perMember.length && !pool.length) throw new QlooBusyError();
    const missing = withTastes.filter((m) => !perMember.some((p) => p.member === m.name)).map((m) => m.name);
    const t2 = Date.now();
    const picks = rankGroup(perMember, pool, { budgetPerPerson: req.budgetPerPerson, top: 3, city: req.city });
    return {
      picks,
      trace: [
        {
          step: "Taste affinities",
          source: "Qloo /v2/insights",
          detail: `${perMember.map((m) => `${m.member}: ${m.picks.length}`).join(", ")} · group signal: ${pool.length} ${occasion.local ? `places in ${req.city}` : "destinations"}` +
            (missing.length ? ` · Qloo busy for ${missing.join(", ")} (scores estimated)` : ""),
          ms: t2 - t,
        },
        {
          step: "Group fit",
          source: "TastePay ranking (least-happy person first)",
          detail: picks.map((p) => `${p.candidate.name} ${Math.round(p.fit * 100)}%`).join(" · ") || "nothing fits the budget",
          ms: Date.now() - t2,
        },
      ],
    };
  }

  /** Step 3: short, grounded explanations; falls back to Qloo tags when no model answers. */
  async explain(
    req: PlanRequest,
    members: ResolvedMember[],
    picks: GroupPick[],
  ): Promise<{ explanations: Record<string, Explanation>; trace: TraceStep }> {
    const t = Date.now();
    const explanations: Record<string, Explanation> = {};
    const facts = {
      occasion: OCCASIONS[req.occasion].label,
      city: req.city,
      people: members.map((m) => ({ name: m.name, loves: m.tastes.map((x) => x.name) })),
      picks: picks.map((p) => ({
        id: p.candidate.id,
        name: p.candidate.name,
        shared_vibe: p.sharedTags.map((x) => x.name),
        fit_per_person: Object.fromEntries(p.perMember.map((s) => [s.member, Math.round(s.score * 100)])),
      })),
    };
    const res = picks.length
      ? await this.llm.chat(
          [
            {
              role: "system",
              content:
                "You explain group recommendations computed from Qloo taste data. Use ONLY the facts given. " +
                "Never invent dishes, prices or events. Reply with JSON only: " +
                '{"picks":[{"id":"...","why":"one sentence for the group","per_person":{"<name>":"short reason linking their favourites to this pick"}}]}',
            },
            { role: "user", content: JSON.stringify(facts) },
          ],
          undefined,
          1500,
          8_500,
          (c) => (extractJson<{ picks?: unknown[] }>(c)?.picks?.length ?? 0) > 0,
        )
      : null;
    const parsed = extractJson<{ picks?: { id: string; why: string; per_person?: Record<string, string> }[] }>(res?.message.content);
    let fromModel = 0;
    for (const p of parsed?.picks ?? []) {
      if (picks.some((x) => x.candidate.id === p.id) && p.why) {
        explanations[p.id] = { why: p.why, perMember: p.per_person ?? {} };
        fromModel++;
      }
    }
    for (const p of picks) explanations[p.candidate.id] ??= templateExplanation(p, members);
    return {
      explanations,
      trace: {
        step: "Explain",
        source: fromModel ? `LLM ${res!.model}` : "Qloo tags (no model answered)",
        detail: fromModel ? `${fromModel} explanations grounded in shared Qloo tags` : "explanations built from the shared Qloo tags",
        ms: Date.now() - t,
      },
    };
  }

  /** The comparison: the same brief answered by an LLM with no taste data, then checked against Qloo. */
  async baseline(req: PlanRequest): Promise<{ text: string | null; claims: Claim[]; trace: TraceStep[] }> {
    const t = Date.now();
    const members = activeMembers(req.members);
    const who = members.map((m) => `${m.name} loves ${m.favourites.join(", ")}`).join("; ");
    const where = OCCASIONS[req.occasion].local ? ` in ${req.city}` : "";
    const budget = req.budgetPerPerson ? `, about €${req.budgetPerPerson} per person` : "";
    const res = await this.llm.chat(
      [{ role: "user", content: `Suggest 3 options for ${OCCASIONS[req.occasion].label}${where} for a group${budget}. ${who}. Name each place and give one line why. Be brief.` }],
      undefined,
      600,
      8_500,
      (c) => c.length > 80 && /\d[.)]|\*\*|^- /m.test(c),
    );
    const text = res?.message.content?.trim() || null;
    const trace: TraceStep[] = [
      { step: "LLM without Qloo", source: res ? `LLM ${res.model}` : "no model answered", detail: "same brief, no taste data", ms: Date.now() - t },
    ];
    let claims: Claim[] = [];
    if (text && OCCASIONS[req.occasion].local) {
      const t2 = Date.now();
      claims = await factCheck(this.qloo, extractNamedPlaces(text), req.city, req.budgetPerPerson);
      const count = (v: Claim["verdict"]) => claims.filter((c) => c.verdict === v).length;
      trace.push({
        step: "Fact-check",
        source: "Qloo /search (places)",
        detail: `${count("in-city")} found in ${req.city}, ${count("other-city")} in another city, ${count("not-found")} not found` +
          (claims.some((c) => c.overBudget) ? `, ${claims.filter((c) => c.overBudget).length} over budget` : ""),
        ms: Date.now() - t2,
      });
    }
    return { text, claims, trace };
  }
}

/**
 * Keep candidates of the right kind (primary genre) and, when enough remain, drop
 * the little-known ones (bottom of Qloo's popularity): a school canteen bar can
 * match a taste profile but is not where a group goes out.
 */
export function keeper(accept?: (genre?: string) => boolean, minPopularity = 0.85, minLeft = 6) {
  return (picks: Candidate[]): Candidate[] => {
    const right = accept ? picks.filter((c) => accept(c.primaryGenre)) : picks;
    const known = right.filter((c) => c.popularity === undefined || c.popularity >= minPopularity);
    return known.length >= minLeft ? known : right;
  };
}

export function templateExplanation(p: GroupPick, members: ResolvedMember[]): Explanation {
  const vibe = p.sharedTags.slice(0, 3).map((t) => t.name.toLowerCase());
  const why = vibe.length ? `Shared vibe across the group: ${vibe.join(", ")}.` : "The best balance between everyone's tastes in Qloo's data.";
  const perMember: Record<string, string> = {};
  for (const s of p.perMember) {
    const loves = members.find((m) => m.name === s.member)?.tastes.map((t) => t.name).join(", ");
    perMember[s.member] = `${Math.round(s.score * 100)}% fit${loves ? ` from ${loves}` : ""}${s.known ? "" : " (estimated)"}`;
  }
  return { why, perMember };
}

/**
 * Rules-only reading of a brief such as
 * "Team dinner in Milan, 40€ each. Sara: Radiohead, Murakami. Luca: Wes Anderson".
 */
export function parseBrief(brief: string): PlanRequest {
  const text = brief.replace(/\r/g, "");
  const lower = text.toLowerCase();
  const occasion: Occasion = /\b(trip|weekend|getaway|travel)\b/.test(lower)
    ? "trip"
    : /\b(drinks?|bar|aperitivo|cocktails?)\b/.test(lower)
      ? "drinks"
      : /\b(museum|gallery|exhibition|culture)\b/.test(lower)
        ? "culture"
        : "dinner";
  const city = text.match(/\b(?:in|at)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?)/u)?.[1];
  const money = text.match(/(?:€|eur\s*|\$)\s*(\d{1,4})|(\d{1,4})\s*(?:€|eur\b|euros?\b|\$|dollars?\b)/i);
  const budget = Number(money?.[1] ?? money?.[2]);
  const members: MemberInput[] = [];
  for (const m of text.matchAll(/(?:^|[.;\n]\s*)([A-Z][\p{L}'-]{1,29})\s*(?::|\bloves\b|\blikes\b)\s*([^.\n;]+)/gu)) {
    members.push({ name: m[1], favourites: m[2].split(/,|\band\b/).map((f) => f.trim()).filter(Boolean) });
  }
  return normalise({ occasion, city, budgetPerPerson: Number.isFinite(budget) ? budget : undefined, members });
}

function normalise(r: PlanRequest): PlanRequest {
  const budget = Number(r.budgetPerPerson);
  return {
    occasion: OCCASIONS[r.occasion] ? r.occasion : "dinner",
    city: r.city?.trim() || undefined,
    budgetPerPerson: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    members: activeMembers(r.members ?? []),
  };
}

function summary(r: PlanRequest): string {
  return `${OCCASIONS[r.occasion]?.label ?? r.occasion}${r.city ? ` in ${r.city}` : ""}${r.budgetPerPerson ? `, €${r.budgetPerPerson}/person` : ""}, ${r.members?.length ?? 0} people`;
}

function shortType(type: string): string {
  return type.replace("urn:entity:", "").replace("_", " ");
}

/** Like Promise.all over `items`, with at most `limit` calls in flight (Qloo rate-limits bursts). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
