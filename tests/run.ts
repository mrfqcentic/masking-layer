import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, type ExpectedExtraction, type TestCase } from "./cases.js";

// Usage:
//   npm test                        (concurrency 4)
//   CONCURRENCY=1 npm test          (sequential)
//   BASE_URL=http://host:port npm test
//
// The runner reuses a running server; it only starts (and stops) one if
// none is reachable. Scoring:
//   pass  = returned JSON identical to expected (labels+categories+values+order)
//   warn  = same values, but categories and/or order differ
//   fail  = missing or extra values
// A JSON report with per-case durations is written next to this file.

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.CONCURRENCY ?? "4", 10) || 4);
const CASE_TIMEOUT_MS = 180_000;
const SERVER_START_TIMEOUT_MS = 20_000;

type Extraction = ExpectedExtraction;
type Status = "pass" | "warn" | "fail" | "error";

interface CategoryMismatch {
  value: string;
  expectedCategory: string;
  gotCategory: string;
}

interface CaseResult {
  id: number;
  name: string;
  status: Status;
  duration_ms: number;
  categoryMismatches: CategoryMismatch[];
  orderMismatch: boolean;
  missing: Extraction[];
  extra: Extraction[];
  error?: string;
}

interface ServerInfo {
  ok?: boolean;
  model?: string;
  temperature?: number;
}

async function fetchHealth(): Promise<ServerInfo | null> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? ((await res.json()) as ServerInfo) : null;
  } catch {
    return null;
  }
}

async function ensureServer(): Promise<(() => void) | null> {
  if ((await fetchHealth()) !== null) return null;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const distEntry = resolve(root, "dist", "index.js");
  const child = existsSync(distEntry)
    ? spawn(process.execPath, [distEntry], { cwd: root, stdio: "ignore" })
    : spawn("npx", ["tsx", "src/index.ts"], { cwd: root, stdio: "ignore" });
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if ((await fetchHealth()) !== null) return () => child.kill("SIGTERM");
  }
  child.kill("SIGTERM");
  throw new Error(`server at ${BASE_URL} did not become healthy`);
}

function countMultiset(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function sameValues(expected: Extraction[], got: Extraction[]): boolean {
  const expectedCounts = countMultiset(expected.map((i) => i.value));
  const gotCounts = countMultiset(got.map((i) => i.value));
  if (expectedCounts.size !== gotCounts.size) return false;
  for (const [value, count] of expectedCounts) {
    if (gotCounts.get(value) !== count) return false;
  }
  return true;
}

function compare(expected: Extraction[], got: Extraction[]) {
  const exact = JSON.stringify(expected) === JSON.stringify(got);
  const valuesMatch = sameValues(expected, got);
  const categoryMismatches: CategoryMismatch[] = [];
  let orderMismatch = false;

  if (valuesMatch && !exact) {
    for (const item of expected) {
      const match = got.find((x) => x.value === item.value);
      if (match && match.category !== item.category) {
        categoryMismatches.push({
          value: item.value,
          expectedCategory: item.category,
          gotCategory: match.category,
        });
      }
    }
    orderMismatch =
      categoryMismatches.length === 0 &&
      expected.some((item, i) => got[i]?.value !== item.value);
  }

  const gotValues = new Set(got.map((i) => i.value));
  const expectedValues = new Set(expected.map((i) => i.value));
  const missing = expected.filter((i) => !gotValues.has(i.value));
  const extra = got.filter((i) => !expectedValues.has(i.value));
  return { exact, valuesMatch, categoryMismatches, orderMismatch, missing, extra };
}

async function runCase(testCase: TestCase): Promise<CaseResult> {
  const started = Date.now();
  const base = { id: testCase.id, name: testCase.name };
  try {
    const res = await fetch(`${BASE_URL}/v1/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: testCase.text }),
      signal: AbortSignal.timeout(CASE_TIMEOUT_MS),
    });
    const duration_ms = Date.now() - started;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ...base,
        status: "error",
        duration_ms,
        categoryMismatches: [],
        orderMismatch: false,
        missing: [],
        extra: [],
        error: `HTTP ${res.status} ${body.slice(0, 160)}`,
      };
    }
    const json = (await res.json()) as { extractions?: Extraction[] };
    const got = Array.isArray(json.extractions) ? json.extractions : [];
    const cmp = compare(testCase.expected, got);
    const status: Status = cmp.exact ? "pass" : cmp.valuesMatch ? "warn" : "fail";
    return {
      ...base,
      status,
      duration_ms,
      categoryMismatches: cmp.categoryMismatches,
      orderMismatch: cmp.orderMismatch,
      missing: cmp.missing,
      extra: cmp.extra,
    };
  } catch (err) {
    return {
      ...base,
      status: "error",
      duration_ms: Date.now() - started,
      categoryMismatches: [],
      orderMismatch: false,
      missing: [],
      extra: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function truncate(text: string, max = 48): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const cleanupServer = await ensureServer();
  const info = await fetchHealth();
  console.log(
    `masking-layer eval: ${CASES.length} cases | ${BASE_URL} | model=${info?.model ?? "?"} temperature=${info?.temperature ?? "?"} | concurrency=${CONCURRENCY}`,
  );

  const results: CaseResult[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < CASES.length) {
      const testCase = CASES[next];
      next += 1;
      const result = await runCase(testCase);
      results.push(result);
      const tag =
        result.status === "pass"
          ? "PASS  (exact)"
          : result.status === "warn"
            ? result.orderMismatch
              ? "WARN  (order)"
              : "WARN  (category)"
            : result.status === "fail"
              ? "FAIL"
              : "ERROR";
      console.log(
        `[${String(result.id).padStart(2, "0")}] ${tag}  ${result.name}  (${(result.duration_ms / 1000).toFixed(1)}s)`,
      );
      for (const m of result.categoryMismatches) {
        console.log(
          `      category: ${m.expectedCategory} -> ${m.gotCategory} for "${truncate(m.value)}"`,
        );
      }
      for (const item of result.missing) {
        console.log(`      missing: ${item.category} "${truncate(item.value)}"`);
      }
      for (const item of result.extra) {
        console.log(`      extra:   ${item.category} "${truncate(item.value)}"`);
      }
      if (result.error) {
        console.log(`      error:   ${result.error}`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const total = results.length;
  const passes = results.filter((r) => r.status === "pass").length;
  const warns = results.filter((r) => r.status === "warn").length;
  const fails = results.filter((r) => r.status === "fail").length;
  const errors = results.filter((r) => r.status === "error").length;
  const categoryWarns = results.filter((r) => r.status === "warn" && !r.orderMismatch).length;
  const orderWarns = results.filter((r) => r.status === "warn" && r.orderMismatch).length;
  const durations = results.map((r) => r.duration_ms).sort((a, b) => a - b);
  const totalMs = Date.now() - startedAt.getTime();
  const avgMs =
    durations.reduce((a, b) => a + b, 0) / Math.max(1, durations.length);
  const medianMs = durations.length > 0 ? durations[Math.floor(durations.length / 2)] : 0;
  const maxMs = durations.length > 0 ? durations[durations.length - 1] : 0;

  const ids = (fn: (r: CaseResult) => boolean): string =>
    results.filter(fn).map((r) => r.id).join(", ") || "none";

  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const reportPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    `results-c${CONCURRENCY}-${stamp}.json`,
  );

  console.log("=".repeat(64));
  console.log(
    `ran ${total} cases in ${(totalMs / 1000).toFixed(1)}s at concurrency ${CONCURRENCY}`,
  );
  console.log(`exact:          ${passes}/${total}`);
  console.log(`warnings:       ${warns}/${total} (category: ${categoryWarns}, order: ${orderWarns})`);
  console.log(`failures:       ${fails}/${total}`);
  console.log(`errors:         ${errors}/${total}`);
  console.log(`value-accurate: ${passes + warns}/${total} (exact + warnings)`);
  console.log(
    `case duration: avg ${(avgMs / 1000).toFixed(1)}s | median ${(medianMs / 1000).toFixed(1)}s | max ${(maxMs / 1000).toFixed(1)}s`,
  );
  console.log(`not exact: ${ids((r) => r.status !== "pass")}`);

  const report = {
    started_at: startedAt.toISOString(),
    base_url: BASE_URL,
    concurrency: CONCURRENCY,
    server: info,
    total_duration_ms: totalMs,
    summary: {
      total,
      passes,
      warnings: warns,
      category_warnings: categoryWarns,
      order_warnings: orderWarns,
      failures: fails,
      errors,
      value_accurate: passes + warns,
      avg_case_ms: Math.round(avgMs),
      median_case_ms: medianMs,
      max_case_ms: maxMs,
    },
    cases: results,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`report: ${reportPath}`);

  cleanupServer?.();
  process.exitCode = fails > 0 || errors > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});