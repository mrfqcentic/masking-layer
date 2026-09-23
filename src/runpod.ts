import { config } from "./config.js";

const API_BASE = "https://api.runpod.io/v2";

export class RunPodError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "RunPodError";
    this.status = status;
  }
}

export interface RunPodPod {
  id: string;
  name?: string;
  status?: string;
  template?: string | null;
  createdAt?: string;
  gpu?: { id?: string; count?: number } | null;
  cost?: { totalAmount?: number } | null;
}

export interface RunPodTemplate {
  id: string;
  name?: string;
  serverless?: boolean;
}

export interface RunPodGpuType {
  id: string;
  name?: string;
  price?: { secure?: number; community?: number } | null;
  dataCenters?: Array<{ id: string; name?: string; availability?: string }>;
}

export interface RunPodDataCenter {
  id: string;
  name?: string;
  region?: string;
}

async function rpFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${config.runpodApiKey}`,
        "content-type": "application/json",
        ...(init?.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new RunPodError("RunPod API request timed out", 504);
    }
    throw new RunPodError(
      `Could not reach the RunPod API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const problem = data as { detail?: string; title?: string } | null;
    const detail =
      problem && typeof problem.detail === "string" && problem.detail
        ? problem.detail
        : problem && typeof problem.title === "string" && problem.title
          ? problem.title
          : `RunPod API returned HTTP ${res.status}`;
    throw new RunPodError(detail, res.status);
  }
  return data as T;
}

export async function listTemplates(): Promise<RunPodTemplate[]> {
  const data = await rpFetch<{ templates?: RunPodTemplate[] }>("/templates");
  return (data.templates ?? []).filter((t) => !t.serverless);
}

export async function listGpuTypes(): Promise<RunPodGpuType[]> {
  const data = await rpFetch<{ gpus?: RunPodGpuType[] }>("/catalog/gpus");
  return data.gpus ?? [];
}

export async function listPods(): Promise<RunPodPod[]> {
  const pods: RunPodPod[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const data = await rpFetch<{
      pods?: RunPodPod[];
      pagination?: { nextCursor?: string; hasMore?: boolean };
    }>(`/pods${query}`);
    pods.push(...(data.pods ?? []));
    const next = data.pagination?.nextCursor;
    if (!next || data.pagination?.hasMore === false) break;
    cursor = next;
  }
  return pods;
}

export async function getPod(podId: string): Promise<RunPodPod> {
  return rpFetch<RunPodPod>(`/pods/${encodeURIComponent(podId)}`);
}

export async function listDataCenters(): Promise<RunPodDataCenter[]> {
  const data = await rpFetch<{ dataCenters?: RunPodDataCenter[] }>(
    "/catalog/datacenters",
  );
  return data.dataCenters ?? [];
}

export async function gpuAvailabilityInRegion(
  gpuTypeId: string,
  region: string,
): Promise<{ available: boolean; dataCenterIds: string[] }> {
  const [dataCenters, catalog] = await Promise.all([
    listDataCenters(),
    rpFetch<{ gpus?: RunPodGpuType[] }>(
      "/catalog/gpus?include=AVAILABILITY&product=POD",
    ),
  ]);
  const regionIds = new Set(
    dataCenters.filter((dc) => dc.region === region).map((dc) => dc.id),
  );
  const gpu = (catalog.gpus ?? []).find((g) => g.id === gpuTypeId);
  const stocked = (gpu?.dataCenters ?? []).filter(
    (dc) =>
      regionIds.has(dc.id) && dc.availability && dc.availability !== "NONE",
  );
  return {
    available: stocked.length > 0,
    dataCenterIds: stocked.map((dc) => dc.id),
  };
}

export async function createPodFromTemplate(input: {
  templateId: string;
  gpuTypeId: string;
  name: string;
  dataCenterIds: string[];
}): Promise<RunPodPod> {
  return rpFetch<RunPodPod>("/pods", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      templateId: input.templateId,
      gpu: { id: input.gpuTypeId, count: 1 },
      cloud: "SECURE",
      dataCenterIds: input.dataCenterIds,
    }),
  });
}

export async function terminatePod(podId: string): Promise<void> {
  await rpFetch<unknown>(`/pods/${encodeURIComponent(podId)}`, {
    method: "DELETE",
  });
}

export async function podAction(
  podId: string,
  action: "start" | "stop" | "restart" | "terminate",
): Promise<void> {
  await rpFetch<unknown>(`/pods/${encodeURIComponent(podId)}/action`, {
    method: "POST",
    body: JSON.stringify({ action }),
  });
}

export function isManagedPod(pod: RunPodPod): boolean {
  if (pod.status === "TERMINATED") return false;
  if (pod.name && pod.name === config.runpodPodName) return true;
  return Boolean(config.runpodTemplateId && pod.template === config.runpodTemplateId);
}

export function podEndpoint(podId: string): { baseUrl: string; apiKey: string } {
  return {
    baseUrl: `https://${podId}-${config.llmPort}.proxy.runpod.net/v1`,
    apiKey: `sk-${podId}`,
  };
}
