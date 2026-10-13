import type { Config } from "@netlify/functions";
import { MAX_FAVOURITES, MAX_MEMBERS, validateRequest, type PlanRequest, type ResolvedMember } from "../../src/agent.ts";
import { getAgent, handle, json, rateLimited, readJson } from "../../src/server.ts";

export default (req: Request) =>
  handle(async () => {
    const body = await readJson<{ request?: PlanRequest; members?: ResolvedMember[] }>(req);
    const problem = body?.request ? validateRequest(body.request) : "Missing request";
    if (problem) return json({ error: problem }, 400);
    const members = (body!.members ?? []).slice(0, MAX_MEMBERS).map((m) => ({
      name: String(m.name).slice(0, 30),
      tastes: (m.tastes ?? []).slice(0, MAX_FAVOURITES).filter((t) => /^[A-F0-9-]{20,40}$/i.test(t.id)),
    }));
    if (members.filter((m) => m.tastes.length).length < 2) return json({ error: "We could not recognise enough favourites. Try more famous ones." }, 400);
    if (rateLimited(req, "rank", 60)) return json({ error: "Too many requests from this address. Try again in an hour." }, 429);
    return json(await getAgent().rank(body!.request!, members));
  });

export const config: Config = { path: "/api/rank" };
