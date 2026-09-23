import type { Extraction } from "./prompt.js";

function normalizeCategory(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) return "unknown";
  return /^[0-9]/.test(cleaned) ? `x_${cleaned}` : cleaned;
}

/**
 * Validate and normalize raw model output:
 * - drop items whose value does not literally occur in the source text
 * - deduplicate category-and-value pairs
 * - order by first appearance in the source text
 * - re-assign labels deterministically (PERSON_n for "name", otherwise
 *   the uppercased category with a per-category counter)
 */
export function sanitizeExtractions(
  message: string,
  raw: unknown[],
): Extraction[] {
  const seen = new Set<string>();
  const valid: Array<{ category: string; value: string; firstIndex: number }> =
    [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { category, value } = item as Record<string, unknown>;
    if (typeof value !== "string" || value.length === 0) continue;
    if (!message.includes(value)) continue;
    const normalized = normalizeCategory(category);
    const key = `${normalized}\u0000${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({
      category: normalized,
      value,
      firstIndex: message.indexOf(value),
    });
  }

  valid.sort((a, b) => a.firstIndex - b.firstIndex);

  const counters = new Map<string, number>();
  return valid.map((item): Extraction => {
    const count = (counters.get(item.category) ?? 0) + 1;
    counters.set(item.category, count);
    const prefix =
      item.category === "name" ? "PERSON" : item.category.toUpperCase();
    return {
      label: `${prefix}_${count}`,
      category: item.category,
      value: item.value,
    };
  });
}

/**
 * Replace every occurrence of each extracted value with its label.
 * Longer matches win over shorter overlapping ones; overlapping matches
 * that fall inside an already-replaced span are skipped.
 */
export function maskText(text: string, extractions: Extraction[]): string {
  interface Match {
    start: number;
    end: number;
    label: string;
    order: number;
  }

  const matches: Match[] = [];
  extractions.forEach((extraction, order) => {
    let index = text.indexOf(extraction.value);
    while (index !== -1) {
      matches.push({
        start: index,
        end: index + extraction.value.length,
        label: extraction.label,
        order,
      });
      index = text.indexOf(extraction.value, index + 1);
    }
  });

  if (matches.length === 0) return text;

  matches.sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      a.order - b.order,
  );

  let masked = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    masked += text.slice(cursor, match.start) + match.label;
    cursor = match.end;
  }
  masked += text.slice(cursor);
  return masked;
}