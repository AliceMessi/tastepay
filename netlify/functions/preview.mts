import type { Config } from "@netlify/functions";
import { previewImage } from "../../src/preview.ts";
import { handle, json, rateLimited, readJson } from "../../src/server.ts";

// The venue website's own preview image, used when Qloo's photo does not load.
export default (req: Request) =>
  handle(async () => {
    const body = await readJson<{ url?: string }>(req, 2_000);
    if (!body?.url) return json({ image: null }, 400);
    if (rateLimited(req, "preview", 120)) return json({ image: null });
    return json({ image: await previewImage(body.url) });
  });

export const config: Config = { path: "/api/preview" };
