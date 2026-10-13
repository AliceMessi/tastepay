// OpenRouter chat client. Free models are rate-limited upstream, so we try a
// short chain and give up quickly: every caller has a deterministic fallback.

// Fastest first: laguna answers in ~2 s without reasoning tokens; the others think first.
export const MODEL_CHAIN = [
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
];

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface ChatResult {
  message: ChatMessage;
  model: string;
}

type Fetch = typeof fetch;

/** OPENROUTER_MODELS (comma separated) overrides the chain without a code change. */
export function modelsFromEnv(value: string | undefined): string[] {
  const list = (value ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : MODEL_CHAIN;
}

export class LlmClient {
  // Successful answers are reused: the same brief twice should not spend the free quota twice.
  private cache = new Map<string, ChatResult>();

  constructor(
    private apiKey: string | undefined,
    private models = MODEL_CHAIN,
    private fetchImpl: Fetch = fetch,
    private timeoutMs = 25_000,
  ) {}

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * First model in the chain that answers wins; null when none does or when
   * `budgetMs` runs out (Netlify functions must answer within ~10 s).
   */
  async chat(messages: ChatMessage[], tools?: ToolSpec[], maxTokens = 700, budgetMs = 8_500): Promise<ChatResult | null> {
    if (!this.apiKey) return null;
    const key = JSON.stringify([messages, tools, maxTokens]);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const deadline = Date.now() + budgetMs;
    for (const model of this.models) {
      const left = deadline - Date.now();
      if (left < 1_500) break;
      try {
        const res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/AliceMessi/tastepay",
            "X-Title": "TastePay",
          },
          body: JSON.stringify({ model, messages, tools, max_tokens: maxTokens, temperature: 0.2 }),
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, left)),
        });
        if (!res.ok) continue;
        const body: any = await res.json();
        const message = body.choices?.[0]?.message;
        if (!message) continue;
        if (!message.tool_calls?.length && !message.content?.trim()) continue;
        const result: ChatResult = { message: { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls }, model };
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, result);
        return result;
      } catch {
        // timeout or network error: try the next model
      }
    }
    return null;
  }
}

/** Pull the first JSON object out of a model reply (models often wrap it in prose or fences). */
export function extractJson<T = unknown>(text: string | null | undefined): T | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
