import { evaluatePropositionSignals, PropositionChecklist } from "@/lib/proposition-gate";
import { CaseCandidate, ConfidenceBand, ContextProfile, ScoredCase } from "@/lib/types";

const QUERY_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "into",
  "under",
  "where",
  "when",
  "from",
  "between",
  "about",
  "case",
  "precedent",
]);

function normalizeTokens(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !QUERY_STOPWORDS.has(token));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let intersect = 0;
  for (const item of a) {
    if (b.has(item)) intersect += 1;
  }
  return intersect / a.size;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function confidenceBandFromScore(score: number): ConfidenceBand {
  if (score >= 0.86) return "VERY_HIGH";
  if (score >= 0.71) return "HIGH";
  if (score >= 0.51) return "MEDIUM";
  return "LOW";
}

function countMatches(haystack: string, needles: string[]): number {
  const lower = haystack.toLowerCase();
  return needles.filter((needle) => needle && lower.includes(needle.toLowerCase())).length;
}

function evaluateChecklistCoverage(corpus: string, checklist?: PropositionChecklist): {
  requiredCoverage: number;
  coreCoverage: number;
  peripheralCoverage: number;
  hookGroupCoverage: number;
  relationSatisfied: boolean;
  outcomePolaritySatisfied: boolean;
  polarityMismatch: boolean;
  matchedLabels: string[];
  missingLabels: string[];
  matchedCoreLabels: string[];
  missingCoreLabels: string[];
  matchedPeripheralLabels: string[];
  missingPeripheralLabels: string[];
  contradiction: boolean;
  evidence: string[];
} {
  if (!checklist) {
    return {
      requiredCoverage: 0,
      coreCoverage: 0,
      peripheralCoverage: 0,
      hookGroupCoverage: 0,
      relationSatisfied: true,
      outcomePolaritySatisfied: true,
      polarityMismatch: false,
      matchedLabels: [],
      missingLabels: [],
      matchedCoreLabels: [],
      missingCoreLabels: [],
      matchedPeripheralLabels: [],
      missingPeripheralLabels: [],
      contradiction: false,
      evidence: [],
    };
  }

  const signal = evaluatePropositionSignals(corpus, checklist);

  return {
    requiredCoverage: signal.requiredCoverage,
    coreCoverage: signal.coreCoverage,
    peripheralCoverage: signal.peripheralCoverage,
    hookGroupCoverage: signal.hookGroupCoverage,
    relationSatisfied: signal.relationSatisfied,
    outcomePolaritySatisfied: signal.outcomePolaritySatisfied,
    polarityMismatch: signal.polarityMismatch,
    matchedLabels: signal.matchedElements,
    missingLabels: signal.missingElements,
    matchedCoreLabels: signal.matchedCoreElements,
    missingCoreLabels: signal.missingCoreElements,
    matchedPeripheralLabels: signal.matchedPeripheralElements,
    missingPeripheralLabels: signal.missingPeripheralElements,
    contradiction: signal.contradiction,
    evidence: unique(signal.evidence).slice(0, 8),
  };
}

function buildSelectionSummary(reasons: string[], court: string): string {
  const preferred = reasons.filter((reason) =>
    /proposition coverage|issue match|procedure match|context anchors|statute\/section match|token overlap/i.test(
      reason,
    ),
  );
  const topReasons = (preferred.length > 0 ? preferred : reasons).slice(0, 2);
  const joined = topReasons.join("; ");
  if (joined.length === 0) {
    return `Selected as a ${court} case match.`;
  }
  return `${court} case selected because ${joined.toLowerCase()}.`;
}

export function scoreCases(
  originalQuery: string,
  context: ContextProfile,
  cases: CaseCandidate[],
  options?: { checklist?: PropositionChecklist },
): ScoredCase[] {
  const queryTokens = new Set(normalizeTokens(originalQuery));

  return cases
    .map((candidate) => {
      const corpus = `${candidate.title} ${candidate.snippet} ${candidate.detailText ?? ""}`;
      const corpusTokens = new Set(normalizeTokens(corpus));
      const overlap = overlapRatio(queryTokens, corpusTokens);

      const anchorsMatched = countMatches(corpus, context.anchors);
      const issuesMatched = countMatches(corpus, context.issues);
      const proceduresMatched = countMatches(corpus, context.procedures);
      const statutesMatched = countMatches(corpus, context.statutesOrSections);
      const proposition = evaluateChecklistCoverage(corpus, options?.checklist);

      const lexicalScore = overlap * 0.38;
      let rawScore = lexicalScore;
      const reasons: string[] = [];

      if (overlap > 0.18) {
        reasons.push(`Token overlap ${(overlap * 100).toFixed(0)}%`);
      }
      if (anchorsMatched > 0) {
        rawScore += Math.min(anchorsMatched * 0.02, 0.14);
        reasons.push(`Context anchors matched: ${anchorsMatched}`);
      }
      if (issuesMatched > 0) {
        rawScore += Math.min(issuesMatched * 0.06, 0.18);
        reasons.push(`Issue match count: ${issuesMatched}`);
      }
      if (proceduresMatched > 0) {
        rawScore += Math.min(proceduresMatched * 0.05, 0.14);
        reasons.push(`Procedure match count: ${proceduresMatched}`);
      }
      if (statutesMatched > 0) {
        rawScore += Math.min(statutesMatched * 0.04, 0.12);
        reasons.push(`Statute/section match count: ${statutesMatched}`);
      }

      if (options?.checklist) {
        if (proposition.requiredCoverage > 0) {
          rawScore += proposition.requiredCoverage * 0.2;
          reasons.push(`Proposition coverage ${(proposition.requiredCoverage * 100).toFixed(0)}%`);
        }
        if (proposition.coreCoverage > 0) {
          rawScore += proposition.coreCoverage * 0.2;
          reasons.push(`Core coverage ${(proposition.coreCoverage * 100).toFixed(0)}%`);
        }
        if (proposition.peripheralCoverage > 0) {
          rawScore += proposition.peripheralCoverage * 0.08;
          reasons.push(`Peripheral coverage ${(proposition.peripheralCoverage * 100).toFixed(0)}%`);
        }
        if (proposition.hookGroupCoverage > 0) {
          rawScore += proposition.hookGroupCoverage * 0.16;
          reasons.push(`Hook-group coverage ${(proposition.hookGroupCoverage * 100).toFixed(0)}%`);
        }
        if (proposition.relationSatisfied && options.checklist.relations.some((relation) => relation.required)) {
          rawScore += 0.06;
          reasons.push("Required hook interaction satisfied");
        }
        if (proposition.outcomePolaritySatisfied && options.checklist.outcomeConstraint.required) {
          rawScore += 0.07;
          reasons.push(`Outcome polarity matched (${options.checklist.outcomeConstraint.polarity})`);
        }
        if (proposition.matchedLabels.length > 0) {
          reasons.push(`Matched elements: ${proposition.matchedLabels.join(", ")}`);
        }
        if (proposition.missingLabels.length > 0) {
          reasons.push(`Missing elements: ${proposition.missingLabels.join(", ")}`);
        }
        if (!proposition.relationSatisfied && options.checklist.relations.some((relation) => relation.required)) {
          rawScore -= 0.13;
          reasons.push("Required hook interaction not satisfied");
        }
        if (proposition.polarityMismatch) {
          rawScore -= 0.2;
          reasons.push("Outcome polarity mismatch");
        }
        if (proposition.contradiction) {
          rawScore -= 0.28;
          reasons.push("Contradiction signal present against required outcome");
        }
        if (proposition.hookGroupCoverage < 1) {
          rawScore -= 0.08;
        }
      }

      if (candidate.court === "SC") {
        rawScore += 0.05;
        reasons.push("Supreme Court weighting");
      } else if (candidate.court === "HC") {
        rawScore += 0.04;
        reasons.push("High Court weighting");
      }

      if (typeof candidate.citedByCount === "number" && candidate.citedByCount >= 50) {
        rawScore += Math.min(candidate.citedByCount / 8000, 0.05);
        reasons.push(`Citation influence (cited by ${candidate.citedByCount})`);
      }

      const centered = (rawScore - 0.45) * 3.1;
      let rankingScore = clamp01(sigmoid(centered));
      rankingScore = Math.min(rankingScore, 0.92);

      if (reasons.length === 0) {
        reasons.push("Weak semantic proximity");
      }

      const confidenceScore = rankingScore;

      return {
        ...candidate,
        score: Number(confidenceScore.toFixed(3)),
        rankingScore: Number(rankingScore.toFixed(3)),
        confidenceScore: Number(confidenceScore.toFixed(3)),
        confidenceBand: confidenceBandFromScore(confidenceScore),
        reasons,
        selectionSummary: buildSelectionSummary(reasons, candidate.court),
        matchEvidence: proposition.evidence,
        verification: {
          anchorsMatched,
          issuesMatched,
          proceduresMatched,
          detailChecked: Boolean(candidate.detailText),
          hasRoleSentence: candidate.evidenceQuality?.hasRoleSentence,
          hasChainSentence: candidate.evidenceQuality?.hasChainSentence,
          hasRelationSentence: candidate.evidenceQuality?.hasRelationSentence,
          hasPolaritySentence: candidate.evidenceQuality?.hasPolaritySentence,
          hasHookIntersectionSentence: candidate.evidenceQuality?.hasHookIntersectionSentence,
        },
      };
    })
    .sort((a, b) => (b.rankingScore ?? b.score) - (a.rankingScore ?? a.score));
}
