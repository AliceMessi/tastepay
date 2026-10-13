// Shared plumbing for the Netlify functions: clients from env, JSON in/out, a light rate limit.

import { QlooBusyError, TasteAgent } from "./agent.ts";
import { LlmClient, modelsFromEnv } from "./llm.ts";
import { QlooClient } from "./qloo.ts";

let agent: TasteAgent | undefined;

/** One agent per function instance, so Qloo's private cache is reused between calls. */
export function getAgent(): TasteAgent {
  agent ??= new TasteAgent(new QlooClient(process.env.QLOO_API_KEY ?? ""), new LlmClient(process.env.OPENROUTER_API_KEY, modelsFromEnv(process.env.OPENROUTER_MODELS)));
  return agent;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function readJson<T>(req: Request, maxBytes = 20_000): Promise<T | null> {
  if (req.method !== "POST") return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// Best effort per-instance limit: protects the free Qloo and OpenRouter quotas from bursts.
const hits = new Map<string, number[]>();
export function rateLimited(req: Request, bucket: string, perHour: number): boolean {
  const ip = req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for") ?? "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > perHour;
}

export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    if (e instanceof QlooBusyError || /HTTP 429/.test(String(e))) {
      return json({ error: "Qloo is busy right now. Please try again in a few seconds.", retry: true }, 503);
    }
    return json({ error: "Something went wrong on our side. Please try again in a moment." }, 502);
  }
}
