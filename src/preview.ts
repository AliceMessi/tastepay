// Link-preview image for a venue's own website (its og:image), used when
// Qloo's photo does not load. Only public http(s) hosts on default ports.

type Fetch = typeof fetch;

const cache = new Map<string, string | null>();
const MAX_BYTES = 400_000;

export function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(u.protocol) || u.port || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  // No IP literals or local names: this endpoint must not reach private networks.
  if (/^[\d.]+$/.test(host) || host.includes(":") || host === "localhost" || !host.includes(".") || /\.(local|internal|lan)$/.test(host)) return null;
  return u;
}

export function findPreviewImage(html: string, base: URL): string | null {
  const metas = [...html.matchAll(/<meta\s[^>]*>/gi)].map((m) => m[0]);
  for (const key of ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) {
    for (const tag of metas) {
      const prop = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
      const content = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
      if (prop === key && content) {
        try {
          const img = new URL(content.replace(/&amp;/g, "&"), base);
          if (img.protocol === "https:" || img.protocol === "http:") return img.href;
        } catch {
          // ignore malformed URLs
        }
      }
    }
  }
  return null;
}

export async function previewImage(raw: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  const url = safeUrl(raw);
  if (!url) return null;
  if (cache.has(url.href)) return cache.get(url.href)!;
  let image: string | null = null;
  try {
    let current = url;
    let res: Response | null = null;
    for (let hop = 0; hop < 3; hop++) {
      res = await fetchImpl(current.href, {
        redirect: "manual",
        headers: { "User-Agent": "TastePayPreview/1.0 (+https://github.com/AliceMessi/tastepay)", Accept: "text/html" },
        signal: AbortSignal.timeout(4_000),
      });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) break;
      const target = safeUrl(new URL(next, current).href);
      if (!target) return null;
      current = target;
    }
    if (res?.ok && (res.headers.get("content-type") ?? "").includes("html")) {
      const html = (await res.text()).slice(0, MAX_BYTES);
      image = findPreviewImage(html, current);
    }
  } catch {
    image = null;
  }
  cache.set(url.href, image);
  return image;
}
