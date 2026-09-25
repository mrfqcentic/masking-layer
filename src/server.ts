import path from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { config } from "./config.js";
import { type LlmEndpoint, LlmError, extractRaw } from "./llm.js";
import { maskText, sanitizeExtractions } from "./mask.js";
import {
  RunPodError,
  type RunPodPod,
  createPodFromTemplate,
  getPod,
  gpuAvailabilityInRegion,
  isManagedPod,
  listPods,
  podEndpoint,
  terminatePod,
} from "./runpod.js";

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

function asyncHandler(
  fn: AsyncHandler,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function requireInboundAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!config.inboundApiKey) {
    next();
    return;
  }
  const header = req.headers.authorization;
  const xKey = req.headers["x-api-key"];
  const provided = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : Array.isArray(xKey)
      ? xKey[0]
      : xKey;
  if (provided !== config.inboundApiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

type InstanceStatus =
  | "none"
  | "provisioning"
  | "starting"
  | "loading"
  | "running"
  | "exited"
  | "error";

const podStatusMap: Record<string, Exclude<InstanceStatus, "none">> = {
  PROVISIONING: "provisioning",
  STARTING: "starting",
  RUNNING: "running",
  EXITED: "exited",
  ERROR: "error",
};

function llmMode(): "static" | "dynamic" | "none" {
  if (config.llmBaseUrl) return "static";
  if (config.runpodApiKey) return "dynamic";
  return "none";
}

const vllmProbeCache = new Map<string, { at: number; ready: boolean }>();

async function isVllmReady(endpoint: LlmEndpoint): Promise<boolean> {
  const cached = vllmProbeCache.get(endpoint.baseUrl);
  if (cached && Date.now() - cached.at < 10_000) return cached.ready;
  let ready = false;
  try {
    const res = await fetch(`${endpoint.baseUrl}/models`, {
      headers: { authorization: `Bearer ${endpoint.apiKey}` },
      signal: AbortSignal.timeout(4_000),
    });
    ready = res.ok;
  } catch {
    ready = false;
  }
  vllmProbeCache.set(endpoint.baseUrl, { at: Date.now(), ready });
  return ready;
}

async function findManagedPod(): Promise<RunPodPod | undefined> {
  const pods = await listPods();
  const managed = pods.filter(isManagedPod);
  const rank = (p: RunPodPod): number => {
    if (p.status === "RUNNING") return 0;
    if (p.status === "STARTING" || p.status === "PROVISIONING") return 1;
    return 2;
  };
  managed.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
  );
  return managed[0];
}

function podSummary(pod: RunPodPod): Record<string, unknown> {
  return {
    id: pod.id,
    name: pod.name ?? null,
    status: pod.status ?? null,
    templateId: pod.template ?? null,
    gpuTypeId: pod.gpu?.id ?? null,
    createdAt: pod.createdAt ?? null,
    costPerHr:
      pod.cost && typeof pod.cost.totalAmount === "number"
        ? pod.cost.totalAmount
        : null,
  };
}

type EndpointResolution =
  | { endpoint: LlmEndpoint }
  | { error: string; status: number };

async function resolveLlmEndpoint(): Promise<EndpointResolution> {
  const mode = llmMode();
  if (mode === "static") {
    return {
      endpoint: { baseUrl: config.llmBaseUrl, apiKey: config.llmApiKey },
    };
  }
  if (mode === "none") {
    return {
      error:
        "No LLM endpoint configured. Set LLM_BASE_URL or RUNPOD_API_KEY.",
      status: 503,
    };
  }
  const pod = await findManagedPod();
  if (!pod) {
    return {
      error: "No LLM instance is available. Provision one first.",
      status: 503,
    };
  }
  if (pod.status !== "RUNNING") {
    return {
      error:
        pod.status === "EXITED"
          ? `The instance is stopped (pod ${pod.id}). Delete it and provision a new one.`
          : `The instance (pod ${pod.id}) is still ${pod.status?.toLowerCase() ?? "unavailable"} — this can take ~6 minutes.`,
      status: 503,
    };
  }
  const endpoint = podEndpoint(pod.id);
  const ready = await isVllmReady(endpoint);
  if (!ready) {
    return {
      error:
        "The instance is running but the model is still loading (up to ~6 minutes after start).",
      status: 503,
    };
  }
  return { endpoint };
}

const NO_GPU_MESSAGE = `No GPU available at the moment (${config.runpodGpuTypeId} in ${config.runpodRegion}). Try again later.`;

function fixedConfig(): Record<string, unknown> {
  return {
    templateId: config.runpodTemplateId,
    templateName: config.runpodTemplateName,
    gpuTypeId: config.runpodGpuTypeId,
    region: config.runpodRegion,
  };
}

async function handleGetInstance(
  _req: Request,
  res: Response,
): Promise<void> {
  const mode = llmMode();
  if (mode === "static") {
    res.json({ mode, status: "running", ready: true, pod: null });
    return;
  }
  if (mode === "none") {
    res.json({ mode, status: "none", ready: false, pod: null });
    return;
  }
  const pod = await findManagedPod();
  if (!pod) {
    let available: boolean | null = null;
    try {
      const check = await gpuAvailabilityInRegion(
        config.runpodGpuTypeId,
        config.runpodRegion,
      );
      available = check.available;
    } catch (err) {
      if (err instanceof RunPodError) {
        log(`runpod availability error (${err.status}): ${err.message}`);
      }
    }
    res.json({
      mode,
      status: "none",
      ready: false,
      pod: null,
      available,
      reason: available === false ? NO_GPU_MESSAGE : null,
      fixed: fixedConfig(),
    });
    return;
  }
  const mapped = podStatusMap[pod.status ?? ""] ?? "error";
  let ready = false;
  if (pod.status === "RUNNING") {
    ready = await isVllmReady(podEndpoint(pod.id));
  }
  res.json({
    mode,
    status: ready ? "running" : mapped === "running" ? "loading" : mapped,
    ready,
    pod: podSummary(pod),
    fixed: fixedConfig(),
  });
}

async function handleCreateInstance(req: Request, res: Response): Promise<void> {
  if (llmMode() !== "dynamic") {
    res.status(409).json({
      error:
        "Provisioning requires dynamic mode: unset LLM_BASE_URL and set RUNPOD_API_KEY.",
    });
    return;
  }
  const existing = await findManagedPod();
  if (existing) {
    res.status(409).json({
      error: `An instance already exists (pod ${existing.id}, status ${existing.status}). Max 1 instance — delete it first.`,
    });
    return;
  }
  let dataCenterIds: string[] = [];
  try {
    const check = await gpuAvailabilityInRegion(
      config.runpodGpuTypeId,
      config.runpodRegion,
    );
    if (!check.available) {
      res.status(503).json({ error: NO_GPU_MESSAGE });
      return;
    }
    dataCenterIds = check.dataCenterIds;
  } catch (err) {
    if (err instanceof RunPodError) {
      res.status(err.status >= 400 && err.status < 500 ? err.status : 502).json({
        error: `RunPod: ${err.message}`,
      });
      return;
    }
    throw err;
  }
  try {
    const pod = await createPodFromTemplate({
      templateId: config.runpodTemplateId,
      gpuTypeId: config.runpodGpuTypeId,
      name: config.runpodPodName,
      dataCenterIds,
    });
    log(
      `provisioned pod ${pod.id} from template ${config.runpodTemplateId} on ${config.runpodGpuTypeId} in ${config.runpodRegion} (${dataCenterIds.join(", ") || "any"})`,
    );
    res.status(201).json({
      mode: "dynamic",
      status: podStatusMap[pod.status ?? ""] ?? "provisioning",
      ready: false,
      pod: podSummary(pod),
      fixed: fixedConfig(),
    });
  } catch (err) {
    if (
      err instanceof RunPodError &&
      /no host|capacity|not available|unavailable|out of stock/i.test(err.message)
    ) {
      res.status(503).json({ error: NO_GPU_MESSAGE });
      return;
    }
    throw err;
  }
}

async function handleDeleteInstance(
  _req: Request,
  res: Response,
): Promise<void> {
  if (llmMode() !== "dynamic") {
    res.status(409).json({ error: "Instance management requires dynamic mode." });
    return;
  }
  const pod = await findManagedPod();
  if (!pod) {
    res.status(404).json({ error: "No instance to delete." });
    return;
  }
  await terminatePod(pod.id);
  vllmProbeCache.delete(podEndpoint(pod.id).baseUrl);
  log(`terminated pod ${pod.id}`);
  res.json({ deleted: pod.id });
}

async function handleListPods(_req: Request, res: Response): Promise<void> {
  const pods = await listPods();
  res.json({
    pods: pods.map((p) => ({ ...podSummary(p), managed: isManagedPod(p) })),
  });
}

async function handleGetPod(req: Request, res: Response): Promise<void> {
  const podId = req.params.podId;
  if (!podId) {
    res.status(400).json({ error: "podId is required." });
    return;
  }
  const pod = await getPod(podId);
  res.json({ pod: { ...podSummary(pod), managed: isManagedPod(pod) } });
}

async function handleExtract(req: Request, res: Response): Promise<void> {
  const started = Date.now();
  const body = (req.body ?? {}) as { message?: unknown; mask?: unknown };

  const message = body.message;
  if (typeof message !== "string" || message.trim().length === 0) {
    res
      .status(400)
      .json({ error: 'Body must be JSON with a non-empty string field "message".' });
    return;
  }
  if (message.length > config.maxMessageChars) {
    res.status(413).json({
      error: `"message" exceeds the maximum of ${config.maxMessageChars} characters.`,
    });
    return;
  }

  const includeMasked = body.mask === undefined ? true : body.mask === true;

  const resolved = await resolveLlmEndpoint();
  if ("error" in resolved) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }

  const { model, raw } = await extractRaw(message, resolved.endpoint);
  const extractions = sanitizeExtractions(message, raw);

  const response: Record<string, unknown> = {
    extractions,
    meta: {
      model,
      extraction_count: extractions.length,
      duration_ms: Date.now() - started,
    },
  };
  if (includeMasked) {
    response.masked_text = maskText(message, extractions);
  }
  res.json(response);
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      log(
        `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`,
      );
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      mode: llmMode(),
      model: config.model ?? "auto",
      temperature: config.temperature,
      experiment: config.extractExperiment,
    });
  });

  const instanceRoutes = [
    "/v1/instance",
    "/instance",
    "/v1/pods",
    "/pods",
    "/v1/pods/:podId",
    "/pods/:podId",
  ];
  app.use(instanceRoutes, requireInboundAuth);
  app.get(["/v1/instance", "/instance"], asyncHandler(handleGetInstance));
  app.post(["/v1/instance", "/instance"], asyncHandler(handleCreateInstance));
  app.delete(["/v1/instance", "/instance"], asyncHandler(handleDeleteInstance));
  app.get(["/v1/pods", "/pods"], asyncHandler(handleListPods));
  app.get(["/v1/pods/:podId", "/pods/:podId"], asyncHandler(handleGetPod));

  app.use(["/v1/extract", "/extract"], requireInboundAuth);
  app.post(["/v1/extract", "/extract"], asyncHandler(handleExtract));

  app.use(express.static(publicDir));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof LlmError) {
        log(`upstream error (${err.status}): ${err.message}`);
        res.status(err.status).json({ error: err.message });
        return;
      }
      if (err instanceof RunPodError) {
        log(`runpod error (${err.status}): ${err.message}`);
        const status = err.status >= 400 && err.status < 500 ? err.status : 502;
        res.status(status).json({ error: `RunPod: ${err.message}` });
        return;
      }
      const e = err as { status?: number; type?: string; message?: string };
      if (
        typeof e.status === "number" &&
        e.status >= 400 &&
        e.status < 500
      ) {
        const message =
          e.type === "entity.parse.failed"
            ? "Request body must be valid JSON."
            : (e.message ?? "Bad request");
        res.status(e.status).json({ error: message });
        return;
      }
      log(`internal error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Internal server error" });
    },
  );

  return app;
}