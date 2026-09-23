import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string): string | undefined {
  const raw = process.env[name];
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export const config = {
  port: num("PORT", 3000),
  llmBaseUrl: (str("LLM_BASE_URL") ?? "").replace(/\/+$/, ""),
  llmApiKey: str("LLM_API_KEY") ?? "",
  model: str("MODEL"),
  temperature: num("LLM_TEMPERATURE", 0.6),
  topP: num("LLM_TOP_P", 0.95),
  maxTokens: num("LLM_MAX_TOKENS", 0) || undefined,
  timeoutMs: num("LLM_TIMEOUT_MS", 120_000),
  maxMessageChars: num("MAX_MESSAGE_CHARS", 100_000),
  inboundApiKey: str("INBOUND_API_KEY"),
  llmPort: num("RUNPOD_LLM_PORT", 8000),
  runpodApiKey: str("RUNPOD_API_KEY") ?? str("RUN_POD_API_KEY"),
  runpodTemplateId: str("RUNPOD_TEMPLATE_ID") ?? "upyll5vq6f",
  runpodTemplateName: str("RUNPOD_TEMPLATE_NAME") ?? "masker",
  runpodGpuTypeId: str("RUNPOD_GPU_TYPE_ID") ?? "NVIDIA RTX PRO 4500 Blackwell",
  runpodPodName: str("RUNPOD_POD_NAME") ?? "masking-layer",
  runpodRegion: str("RUNPOD_REGION") ?? "EUROPE",
};