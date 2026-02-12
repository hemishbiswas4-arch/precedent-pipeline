import { ContextProfile, ScoredCase, SearchInsights } from "@/lib/types";

function round(value: number, digits = 2): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function dominantCourt(cases: ScoredCase[]): "SC" | "HC" | "UNKNOWN" {
  const counts = cases.reduce(
    (acc, item) => {
      acc[item.court] += 1;
      return acc;
    },
    { SC: 0, HC: 0, UNKNOWN: 0 },
  );

  if (counts.SC >= counts.HC && counts.SC >= counts.UNKNOWN) return "SC";
  if (counts.HC >= counts.SC && counts.HC >= counts.UNKNOWN) return "HC";
  return "UNKNOWN";
}

function topUnique(values: string[], limit: number): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].slice(0, limit);
}

export function buildSearchInsights(input: {
  context: ContextProfile;
  cases: ScoredCase[];
  totalFetched: number;
  filteredCount: number;
}): SearchInsights {
  const { context, cases, totalFetched, filteredCount } = input;

  const scCount = cases.filter((c) => c.court === "SC").length;
  const hcCount = cases.filter((c) => c.court === "HC").length;
  const averageScore = average(cases.map((item) => item.score));
  const detailChecked = cases.filter((item) => item.verification.detailChecked).length;
  const verificationCoverage = cases.length > 0 ? detailChecked / cases.length : 0;
  const retrievalEfficiency = totalFetched > 0 ? filteredCount / totalFetched : 0;

  let summary = "No relevant case matches were returned in this run.";
  if (cases.length > 0) {
    const court = dominantCourt(cases);
    const topCase = cases[0];
    const anchorHits = average(cases.map((item) => item.verification.anchorsMatched));
    const issueHits = average(cases.map((item) => item.verification.issuesMatched));
    const confidence = topCase.confidenceScore ?? topCase.score;
    summary = `${cases.length} case candidates were ranked with ${court} court dominance. Top result \"${topCase.title}\" has ${topCase.confidenceBand ?? "LOW"} confidence (${Math.round(confidence * 100)}%) with average anchor matches ${round(anchorHits, 1)} and issue matches ${round(issueHits, 1)}.`;
  }

  return {
    summary,
    topSignals: {
      anchors: topUnique(context.anchors, 6),
      issues: topUnique(context.issues, 4),
      procedures: topUnique(context.procedures, 4),
      statutes: topUnique(context.statutesOrSections, 4),
    },
    quality: {
      averageScore: round(averageScore, 3),
      verificationCoverage: round(verificationCoverage, 3),
      totalCases: cases.length,
      scCount,
      hcCount,
      retrievalEfficiency: round(retrievalEfficiency, 3),
    },
  };
}
