// Live quality check across occasions and cities: node --env-file=.env --import tsx scripts/cities.ts
import { TasteAgent, type Occasion } from "../src/agent.ts";
import { LlmClient } from "../src/llm.ts";
import { QlooClient } from "../src/qloo.ts";

const agent = new TasteAgent(new QlooClient(process.env.QLOO_API_KEY!), new LlmClient(undefined));
const members = [
  { name: "Sara", favourites: ["Radiohead", "Haruki Murakami"] },
  { name: "Luca", favourites: ["The Grand Budapest Hotel", "Miles Davis"] },
  { name: "Giulia", favourites: ["Spirited Away", "Billie Eilish"] },
];
const r = await agent.resolve(members);
for (const [occasion, city] of [["dinner", "Milan"], ["drinks", "Milan"], ["culture", "London"], ["dinner", "New York"], ["dinner", "Rome"], ["drinks", "Berlin"]] as [Occasion, string][]) {
  const t = Date.now();
  const k = await agent.rank({ occasion, city, budgetPerPerson: 40, members }, r.members);
  console.log(`${occasion} ${city} (${Date.now() - t} ms): ${k.picks.map((p) => `${p.candidate.name} [${p.candidate.primaryGenre?.replace("urn:tag:genre:place:", "")}] ${Math.round(p.fit * 100)}%`).join(" | ")}  — ${k.trace[0].detail.split("·").pop()}`);
}
