import type { AttireDetectionMode } from "../interfaces/demo.interface";

export type DetectionSource = "image" | "camera";

export interface DetectionHistoryEntry {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  source: DetectionSource;
  attireMode: AttireDetectionMode;
  peopleDetected: number;
  targetCount: number;
  otherCount: number;
  uncertainCount: number;
  unclassifiedCount: number;
}

const STORAGE_KEY = "icat-detection-history-v1";
const HISTORY_LIMIT = 200;

function isHistoryEntry(value: unknown): value is DetectionHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DetectionHistoryEntry>;
  const counts = [
    entry.peopleDetected,
    entry.targetCount,
    entry.otherCount,
    entry.uncertainCount,
    entry.unclassifiedCount,
    entry.durationMs,
  ];

  return (
    typeof entry.id === "string" &&
    typeof entry.startedAt === "number" &&
    typeof entry.completedAt === "number" &&
    counts.every((count) => typeof count === "number" && count >= 0) &&
    (entry.source === "image" || entry.source === "camera") &&
    (entry.attireMode === "student" || entry.attireMode === "medical")
  );
}

export function createHistoryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function loadDetectionHistory(): DetectionHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(isHistoryEntry)
      .map(entry => ({ ...entry,
        peopleDetected: entry.targetCount + entry.otherCount + entry.uncertainCount,
        unclassifiedCount: 0,
      }))
      .filter(entry => entry.peopleDetected > 0)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function upsertDetectionHistory(
  entries: DetectionHistoryEntry[],
  entry: DetectionHistoryEntry,
): DetectionHistoryEntry[] {
  return [entry, ...entries.filter((item) => item.id !== entry.id)]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, HISTORY_LIMIT);
}

export function persistDetectionHistory(
  entries: DetectionHistoryEntry[],
): boolean {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(entries.slice(0, HISTORY_LIMIT)),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearDetectionHistory(): boolean {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
