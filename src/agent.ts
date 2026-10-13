// The TastePay agent: understand the brief, resolve tastes with Qloo, find what
// fits the whole group, explain it, and show what an LLM alone would have said.
// Each step is a separate call so a serverless function answers within ~10 s.

import { extractJson, LlmClient } from "./llm.ts";
import { rankGroup, type GroupPick, type MemberScores } from "./group.ts";
import { QlooClient, type TasteEntity } from "./qloo.ts";

export type Occasion = "dinner" | "drinks" | "culture" | "trip";

export const OCCASIONS: Record<Occasion, { label: string; type: string; tags?: string[]; local: boolean }> = {
  dinner: { label: "dinner", type: "urn:entity:place", tags: ["urn:tag:genre:place:restaurant"], local: true },
  drinks: { label: "drinks", type: "urn:entity:place", tags: ["urn:tag:genre:place:restaurant:bar"], local: true },
  culture: { label: "a culture outing", type: "urn:entity:place", tags: ["urn:tag:genre:place:museum", "urn:tag:genre:place:art_gallery"], local: true },
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
    ]);
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
            return hits.length ? { ...hits[0], query, alternatives: hits.slice(1, 4) } : null;
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
    const [perMember, pool] = await Promise.all([
      mapLimit(withTastes, 2, async (m): Promise<MemberScores> => ({
        member: m.name,
        picks: await this.qloo.insights({ ...base, entityIds: m.tastes.map((x) => x.id) }),
      })),
      this.qloo.insights({ ...base, entityIds: withTastes.flatMap((m) => m.tastes.map((x) => x.id)) }),
    ]);
    const t2 = Date.now();
    const picks = rankGroup(perMember, pool, { budgetPerPerson: req.budgetPerPerson, top: 3, city: req.city });
    return {
      picks,
      trace: [
        {
          step: "Taste affinities",
          source: "Qloo /v2/insights",
          detail: `${perMember.map((m) => `${m.member}: ${m.picks.length}`).join(", ")} · group signal: ${pool.length} ${occasion.local ? `in ${req.city}` : "destinations"}`,
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

  /** The comparison: the same brief answered by an LLM with no taste data. */
  async baseline(req: PlanRequest): Promise<{ text: string | null; trace: TraceStep }> {
    const t = Date.now();
    const members = activeMembers(req.members);
    const who = members.map((m) => `${m.name} loves ${m.favourites.join(", ")}`).join("; ");
    const where = OCCASIONS[req.occasion].local ? ` in ${req.city}` : "";
    const budget = req.budgetPerPerson ? `, about €${req.budgetPerPerson} per person` : "";
    const res = await this.llm.chat(
      [{ role: "user", content: `Suggest 3 options for ${OCCASIONS[req.occasion].label}${where} for a group${budget}. ${who}. Name each place and give one line why. Be brief.` }],
      undefined,
      600,
    );
    return {
      text: res?.message.content?.trim() || null,
      trace: { step: "LLM without Qloo", source: res ? `LLM ${res.model}` : "no model answered", detail: "same brief, no taste data", ms: Date.now() - t },
    };
  }
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
