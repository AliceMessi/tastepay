// Qloo Taste AI client for the hackathon API. The key is read server-side only.

export const QLOO_BASE_URL = "https://hackathon.api.qloo.com";

// Entity types a person can name as a favourite. /search spells video games
// "videogame" (insights uses "video_game").
export const TASTE_TYPES = [
  "urn:entity:artist",
  "urn:entity:movie",
  "urn:entity:tv_show",
  "urn:entity:book",
  "urn:entity:author",
  "urn:entity:person",
  "urn:entity:podcast",
  "urn:entity:videogame",
  "urn:entity:brand",
] as const;

export interface TasteEntity {
  id: string;
  name: string;
  type: string;
  detail?: string;
}

export interface Tag {
  id: string;
  name: string;
  type: string;
}

export interface Candidate {
  id: string;
  name: string;
  affinity: number;
  tags: Tag[];
  priceLevel?: number;
  rating?: number;
  address?: string;
  image?: string;
  website?: string;
  description?: string;
  closed?: boolean;
  primaryGenre?: string;
  popularity?: number;
}

export interface PlaceHit {
  id: string;
  name: string;
  city?: string;
  address?: string;
  priceLevel?: number;
}

export interface InsightsQuery {
  type: string;
  entityIds: string[];
  location?: string;
  tags?: string[];
  take?: number;
  page?: number;
}

type Fetch = typeof fetch;

export class QlooClient {
  private cache = new Map<string, unknown>();

  constructor(
    private apiKey: string,
    private baseUrl = QLOO_BASE_URL,
    private fetchImpl: Fetch = fetch,
    private timeoutMs = 8_000,
    private retries = 3,
    private backoffMs = 700,
  ) {
    if (!apiKey) throw new Error("QLOO_API_KEY is not set");
  }

  private async get(path: string, params: Record<string, string>): Promise<any> {
    const url = `${this.baseUrl}${path}?${new URLSearchParams(params)}`;
    if (this.cache.has(url)) return this.cache.get(url);
    let res: Response | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      res = await this.fetchImpl(url, {
        headers: { "X-Api-Key": this.apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status !== 429 && res.status < 500) break;
      // Rate limited or transient error: back off, honouring Retry-After when present.
      const wait = Number(res.headers.get("retry-after")) * 1000 || this.backoffMs * 2 ** attempt;
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, wait));
    }
    if (!res!.ok) throw new Error(`Qloo ${path} failed: HTTP ${res!.status}`);
    const body = await res!.json();
    this.cache.set(url, body);
    return body;
  }

  /** Best matches for a favourite typed by a person, across taste types. */
  async search(query: string, types: readonly string[] = TASTE_TYPES, take = 5): Promise<TasteEntity[]> {
    const body = await this.get("/search", { query, types: types.join(","), take: String(take) });
    return (body.results ?? []).map((r: any) => ({
      id: r.entity_id,
      name: r.name,
      type: (r.types ?? [r.subtype])[0],
      detail: r.disambiguation ?? undefined,
    }));
  }

  /** Venues matching a name, with where they are (used to fact-check other answers). */
  async searchPlaces(name: string, take = 3): Promise<PlaceHit[]> {
    const body = await this.get("/search", { query: name, types: "urn:entity:place", take: String(take) });
    return (body.results ?? []).map((r: any) => {
      const p = r.properties ?? {};
      const price = Number(p.price_level);
      return {
        id: r.entity_id,
        name: r.name,
        city: p.geocode?.city ?? p.locality?.city?.name ?? undefined,
        address: p.address ?? undefined,
        priceLevel: Number.isFinite(price) && price > 0 ? price : undefined,
      };
    });
  }

  /** Entities of `type` ranked by affinity to the given taste signals. */
  async insights(q: InsightsQuery): Promise<Candidate[]> {
    const params: Record<string, string> = {
      "filter.type": q.type,
      "signal.interests.entities": q.entityIds.join(","),
      take: String(Math.min(q.take ?? 50, 50)),
    };
    if (q.location) params["filter.location.query"] = q.location;
    if (q.tags?.length) params["filter.tags"] = q.tags.join(",");
    if (q.page && q.page > 1) params.page = String(q.page);
    const body = await this.get("/v2/insights", params);
    return (body.results?.entities ?? []).map(toCandidate);
  }
}

export function toCandidate(e: any): Candidate {
  const p = e.properties ?? {};
  const price = Number(p.price_level);
  const rating = Number(p.business_rating);
  return {
    id: e.entity_id,
    name: e.name,
    affinity: e.query?.affinity ?? 0,
    tags: (e.tags ?? []).map((t: any) => ({ id: t.tag_id ?? t.id, name: t.name, type: t.type })),
    priceLevel: Number.isFinite(price) && price > 0 ? price : undefined,
    rating: Number.isFinite(rating) && rating > 0 ? Math.round(rating * 10) / 10 : undefined,
    address: p.address ?? undefined,
    image: p.images?.[0]?.url ?? undefined,
    website: p.website ?? undefined,
    description: p.short_description ?? p.description ?? undefined,
    closed: p.is_closed === true,
    primaryGenre: p.primary_genre?.id ?? undefined,
    popularity: typeof e.popularity === "number" ? e.popularity : undefined,
  };
}
