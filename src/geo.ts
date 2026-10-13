// Fallback geocoding for towns Qloo cannot resolve by name ("Molfetta"): we look
// the town up on OpenStreetMap once and ask Qloo for places within a radius.

export interface Point {
  lat: number;
  lon: number;
  label: string;
}

type Fetch = typeof fetch;

const cache = new Map<string, Point | null>();

export async function geocode(city: string, fetchImpl: Fetch = fetch): Promise<Point | null> {
  const key = city.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  try {
    const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: city, format: "json", limit: "1", "accept-language": "en" })}`;
    // Nominatim's usage policy asks for an identifying User-Agent and low volume; results are cached.
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "TastePay/1.0 (https://github.com/AliceMessi/tastepay)" },
      signal: AbortSignal.timeout(5_000),
    });
    const hits: any[] = res.ok ? await res.json() : [];
    const hit = hits[0];
    const point = hit ? { lat: Number(hit.lat), lon: Number(hit.lon), label: String(hit.display_name).split(",").slice(0, 2).join(",") } : null;
    cache.set(key, point);
    return point;
  } catch {
    return null;
  }
}
