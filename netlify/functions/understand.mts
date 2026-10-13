import type { Config } from "@netlify/functions";
import { getAgent, handle, json, rateLimited, readJson } from "../../src/server.ts";

export default (req: Request) =>
  handle(async () => {
    const body = await readJson<{ brief?: string }>(req);
    if (!body?.brief?.trim()) return json({ error: "Write a short brief first." }, 400);
    if (rateLimited(req, "plan", 30)) return json({ error: "Too many plans from this address. Try again in an hour." }, 429);
    return json(await getAgent().understand(body.brief));
  });

export const config: Config = { path: "/api/understand" };
