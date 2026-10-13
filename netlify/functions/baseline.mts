import type { Config } from "@netlify/functions";
import { validateRequest, type PlanRequest } from "../../src/agent.ts";
import { getAgent, handle, json, rateLimited, readJson } from "../../src/server.ts";

export default (req: Request) =>
  handle(async () => {
    const body = await readJson<{ request?: PlanRequest }>(req);
    const problem = body?.request ? validateRequest(body.request) : "Missing request";
    if (problem) return json({ error: problem }, 400);
    if (rateLimited(req, "llm", 40)) return json({ text: null, claims: [], trace: [{ step: "LLM without Qloo", source: "skipped (rate limit)", detail: "", ms: 0 }] });
    return json(await getAgent().baseline(body!.request!));
  });

export const config: Config = { path: "/api/baseline" };
