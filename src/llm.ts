import { config } from "./config.js";
import { parsePairChain, RESPONSE_FORMAT, systemInstruction } from "./prompt.js";

export interface LlmEndpoint {
  baseUrl: string;
  apiKey: string;
}

export class LlmError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
}

const modelCache = new Map<string, Promise<string>>();

function authHeaders(endpoint: LlmEndpoint): Record<string, string> {
  return endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {};
}

async function fetchModelId(endpoint: LlmEndpoint): Promise<string> {
  const res = await fetch(`${endpoint.baseUrl}/models`, {
    headers: authHeaders(endpoint),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) {
    throw new LlmError(`Model discovery failed with HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const id = json.data?.[0]?.id;
  if (!id) {
    throw new LlmError("No models are available on the LLM endpoint");
  }
  return id;
}

export function resolveModel(endpoint: LlmEndpoint): Promise<string> {
  if (config.model) return Promise.resolve(config.model);
  let cached = modelCache.get(endpoint.baseUrl);
  if (!cached) {
    cached = fetchModelId(endpoint).catch((err) => {
      modelCache.delete(endpoint.baseUrl);
      throw err;
    });
    modelCache.set(endpoint.baseUrl, cached);
  }
  return cached;
}

function parseJsonArray(content: string): unknown[] {
  const attempt = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const direct = attempt(content.trim());
  if (Array.isArray(direct)) return direct;
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start !== -1 && end > start) {
    const sliced = attempt(content.slice(start, end + 1));
    if (Array.isArray(sliced)) return sliced;
  }
  throw new LlmError("LLM returned malformed JSON");
}

export async function extractRaw(
  message: string,
  endpoint: LlmEndpoint,
): Promise<{ model: string; raw: unknown[] }> {
  const model = await resolveModel(endpoint);
  const experiment = config.extractExperiment === 2 ? 2 : config.extractExperiment === 1 ? 1 : 0;
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemInstruction(experiment) },
      { role: "user", content: message },
    ],
    temperature: config.temperature,
    top_p: config.topP,
    chat_template_kwargs: { enable_thinking: true },
  };
  if (experiment !== 2) body.response_format = RESPONSE_FORMAT;
  if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens;

  let res: Response;
  try {
    res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(endpoint) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new LlmError("LLM request timed out", 504);
    }
    throw new LlmError(`LLM request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(
      `LLM returned HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }

  const json = (await res.json()) as ChatCompletionResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || (experiment !== 2 && content.trim() === "")) {
    throw new LlmError("LLM returned empty content");
  }
  if (experiment === 2) return { model, raw: parsePairChain(content) };
  const visible = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  return { model, raw: parseJsonArray(visible || content) };
}