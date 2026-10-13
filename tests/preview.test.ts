import { describe, expect, it } from "vitest";
import { findPreviewImage, previewImage, safeUrl } from "../src/preview.ts";
import { toCandidate } from "../src/qloo.ts";

describe("safeUrl", () => {
  it("allows public http(s) sites only", () => {
    expect(safeUrl("https://www.example-bistro.it/menu")?.hostname).toBe("www.example-bistro.it");
    for (const bad of ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://localhost:8080", "https://intranet/", "ftp://x.com", "https://x.com:8443/", "http://[::1]/"]) {
      expect(safeUrl(bad)).toBeNull();
    }
  });
});

describe("findPreviewImage", () => {
  it("reads og:image, resolving relative URLs", () => {
    const html = '<head><meta name="description" content="x"><meta content="/img/hero.jpg" property="og:image"></head>';
    expect(findPreviewImage(html, new URL("https://bistro.example.com/home"))).toBe("https://bistro.example.com/img/hero.jpg");
    expect(findPreviewImage("<p>no meta</p>", new URL("https://a.example.com"))).toBeNull();
  });
});

describe("previewImage", () => {
  it("refuses redirects to private hosts", async () => {
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })) as typeof fetch;
    expect(await previewImage("https://redirector.example.com/", fetchImpl)).toBeNull();
  });
});

describe("toCandidate", () => {
  it("keeps useful venue details and trims long texts", () => {
    const c = toCandidate({
      entity_id: "x", name: "Trattoria", query: { affinity: 0.7 }, tags: [],
      properties: {
        images: [{ url: "https://img/1.jpg" }, { url: "https://img/2.jpg" }], live_music: true, phone: "+39 080 000",
        specialty_dishes: [{ name: "Orecchiette" }], keywords: [{ name: "cozy" }, { name: "seafood" }],
        unique_selling_points: "A".repeat(400) + ". End.", hours: { monday: [{ opens: "T12:00:00", closes: "T15:00:00", closed: false }] },
      },
    });
    expect(c.images).toEqual(["https://img/1.jpg", "https://img/2.jpg"]);
    expect(c).toMatchObject({ liveMusic: true, phone: "+39 080 000", specialties: ["Orecchiette"], keywords: ["cozy", "seafood"] });
    expect(c.details!.highlights!.length).toBeLessThanOrEqual(321);
    expect(c.hours!.monday[0].opens).toBe("T12:00:00");
  });
});
