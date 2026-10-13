import type { Config } from "@netlify/functions";
import { activeMembers, type MemberInput } from "../../src/agent.ts";
import { getAgent, handle, json, rateLimited, readJson } from "../../src/server.ts";

export default (req: Request) =>
  handle(async () => {
    const body = await readJson<{ members?: MemberInput[] }>(req);
    const members = activeMembers(body?.members ?? []);
    if (members.length < 2) return json({ error: "Add at least two people with at least one favourite each." }, 400);
    if (rateLimited(req, "resolve", 60)) return json({ error: "Too many requests from this address. Try again in an hour." }, 429);
    return json(await getAgent().resolve(members));
  });

export const config: Config = { path: "/api/resolve" };
