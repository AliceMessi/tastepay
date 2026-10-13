import type { Config } from "@netlify/functions";
import type { PlanRequest, ResolvedMember } from "../../src/agent.ts";
import type { GroupPick } from "../../src/group.ts";
import { getAgent, handle, json, rateLimited, readJson } from "../../src/server.ts";

export default (req: Request) =>
  handle(async () => {
    const body = await readJson<{ request?: PlanRequest; members?: ResolvedMember[]; picks?: GroupPick[] }>(req, 60_000);
    if (!body?.request || !body.members || !body.picks?.length) return json({ error: "Missing plan" }, 400);
    if (rateLimited(req, "llm", 40)) return json({ explanations: {}, trace: { step: "Explain", source: "skipped (rate limit)", detail: "", ms: 0 } });
    return json(await getAgent().explain(body.request, body.members, body.picks.slice(0, 3)));
  });

export const config: Config = { path: "/api/explain" };
