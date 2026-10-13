// Live smoke test of every agent step: node --env-file=.env --import tsx scripts/smoke.ts [brief]
import { TasteAgent } from "../src/agent.ts";
import { LlmClient } from "../src/llm.ts";
import { QlooClient } from "../src/qloo.ts";

const agent = new TasteAgent(new QlooClient(process.env.QLOO_API_KEY!), new LlmClient(process.env.OPENROUTER_API_KEY));
const brief = process.argv[2] ?? "Team dinner in Milan on Friday, about 40€ each. Sara: Radiohead, Haruki Murakami. Luca: The Grand Budapest Hotel, Miles Davis. Giulia: Spirited Away, Billie Eilish.";
const log = (s: { step: string; source: string; ms: number; detail: string }) => console.log(`[${s.step}] ${s.source} ${s.ms}ms — ${s.detail}`);

const u = await agent.understand(brief); log(u.trace);
const r = await agent.resolve(u.request.members); log(r.trace);
const k = await agent.rank(u.request, r.members); k.trace.forEach(log);
const [e, b] = await Promise.all([agent.explain(u.request, r.members, k.picks), agent.baseline(u.request)]);
log(e.trace); b.trace.forEach(log);
for (const p of k.picks) {
  const x = e.explanations[p.candidate.id];
  console.log(`\n* ${p.candidate.name} ${Math.round(p.fit * 100)}% | ${p.sharedTags.map((t) => t.name).join(", ")}\n  ${x.why}\n  ${JSON.stringify(x.perMember)}`);
}
console.log("\nWITHOUT QLOO:", (b.text ?? "none").slice(0, 300));
for (const c of b.claims) console.log(`  - ${c.named}: ${c.verdict}${c.match ? ` (${c.match.name}, ${c.match.city ?? c.match.address})` : ""}${c.overBudget ? " OVER BUDGET" : ""}`);
