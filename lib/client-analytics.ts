export type SessionRunMetric = {
  timestamp: number;
  requestId?: string;
  totalFetched: number;
  filteredCount: number;
  casesCount: number;
  averageScore: number;
  scCount: number;
  hcCount: number;
  blocked: boolean;
};

const STORAGE_KEY = "precedentfinder_session_runs_v1";
const MAX_STORED_RUNS = 20;

function hasSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function loadSessionRuns(): SessionRunMetric[] {
  if (!hasSessionStorage()) return [];
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SessionRunMetric[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item.timestamp === "number");
  } catch {
    return [];
  }
}

export function saveSessionRun(metric: SessionRunMetric): SessionRunMetric[] {
  if (!hasSessionStorage()) return [];
  const current = loadSessionRuns();
  const next = [metric, ...current].slice(0, MAX_STORED_RUNS);
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function clearSessionRuns(): void {
  if (!hasSessionStorage()) return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function summarizeSessionRuns(runs: SessionRunMetric[]): {
  totalRuns: number;
  successRate: number;
  avgCasesPerRun: number;
  avgScore: number;
  blockedRuns: number;
} {
  if (runs.length === 0) {
    return {
      totalRuns: 0,
      successRate: 0,
      avgCasesPerRun: 0,
      avgScore: 0,
      blockedRuns: 0,
    };
  }

  const successful = runs.filter((run) => run.casesCount > 0).length;
  const blockedRuns = runs.filter((run) => run.blocked).length;
  const avgCasesPerRun = runs.reduce((sum, run) => sum + run.casesCount, 0) / runs.length;
  const avgScore = runs.reduce((sum, run) => sum + run.averageScore, 0) / runs.length;

  return {
    totalRuns: runs.length,
    successRate: successful / runs.length,
    avgCasesPerRun,
    avgScore,
    blockedRuns,
  };
}
