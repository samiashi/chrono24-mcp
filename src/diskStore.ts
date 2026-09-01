import fs from "node:fs";
import path from "node:path";

type Entry = { at: number; v: unknown };

function readAll(file: string): Record<string, Entry> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

export function diskRead<T>(
  file: string,
  key: string,
  ttlS: number,
): { value: T; remainingS: number } | null {
  const entry = readAll(file)[key];
  if (!entry || typeof entry.at !== "number") return null;
  const ageS = (Date.now() - entry.at) / 1000;
  if (!Number.isFinite(ageS) || ageS < 0 || ageS >= ttlS) return null;
  return { value: entry.v as T, remainingS: ttlS - ageS };
}

export function diskWrite(file: string, key: string, value: unknown, pruneTtlS: number): void {
  try {
    const all = readAll(file);
    all[key] = { at: Date.now(), v: value };
    const cutoff = Date.now() - pruneTtlS * 1000;
    for (const [k, entry] of Object.entries(all)) {
      if (!entry || typeof entry.at !== "number" || entry.at < cutoff) delete all[k];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all));
  } catch (err) {
    console.error(`[disk-cache] write failed for ${file}: ${err instanceof Error ? err.message : err}`);
  }
}
