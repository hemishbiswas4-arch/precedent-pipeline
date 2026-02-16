import { evaluatePropositionSignals, PropositionChecklist, PropositionSignalInput } from "@/lib/proposition-gate";
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

function evaluateChecklistCoverage(input: string | PropositionSignalInput, checklist?: PropositionChecklist): {
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

  const signal = evaluatePropositionSignals(input, checklist);

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

type CanonicalLexicalProfile = {
  mustIncludeTokens?: string[];
  strictVariantTokens?: string[];
  checklistTokens?: string[];
  contradictionTokens?: string[];
};

type CandidateProvenanceProfile = {
  bestUtility: number;
  strictHits: number;
  relaxedHits: number;
  highPriorityHits?: number;
};

export function scoreCases(
  originalQuery: string,
  context: ContextProfile,
  cases: CaseCandidate[],
  options?: {
    checklist?: PropositionChecklist;
    canonicalLexicalProfile?: CanonicalLexicalProfile;
    candidateProvenance?: Record<string, CandidateProvenanceProfile>;
  },
): ScoredCase[] {
  const rawQueryTokens = new Set(normalizeTokens(originalQuery));
  const mustIncludeTokens = new Set(
    normalizeTokens((options?.canonicalLexicalProfile?.mustIncludeTokens ?? []).join(" ")),
  );
  const strictVariantTokens = new Set(
    normalizeTokens((options?.canonicalLexicalProfile?.strictVariantTokens ?? []).join(" ")),
  );
  const checklistTokens = new Set(
    normalizeTokens((options?.canonicalLexicalProfile?.checklistTokens ?? []).join(" ")),
  );
  const contradictionTokens = unique(
    normalizeTokens((options?.canonicalLexicalProfile?.contradictionTokens ?? []).join(" ")),
  );

  return cases
    .map((candidate) => {
      const evidenceText = candidate.detailArtifact?.evidenceWindows?.join(" ") ?? "";
      const bodyText = candidate.detailArtifact?.bodyExcerpt?.join(" ") ?? candidate.detailText ?? "";
      const corpus = `${candidate.title} ${candidate.snippet} ${bodyText}`;
      const corpusTokens = new Set(normalizeTokens(corpus));
      const rawOverlap = overlapRatio(rawQueryTokens, corpusTokens);
      const mustIncludeOverlap = overlapRatio(mustIncludeTokens, corpusTokens);
      const strictOverlap = overlapRatio(strictVariantTokens, corpusTokens);
      const checklistOverlap = overlapRatio(checklistTokens, corpusTokens);
      const blendedOverlap =
        rawOverlap * 0.2 + mustIncludeOverlap * 0.35 + strictOverlap * 0.25 + checklistOverlap * 0.2;
      const detailChecked = Boolean(candidate.detailText || candidate.detailArtifact?.evidenceWindows?.length);
      const detailWeight = detailChecked ? 1 : 0.62;
      const provenance = options?.candidateProvenance?.[candidate.url];
      const rerankScore = candidate.retrieval?.rerankScore;
      const fusionScore = candidate.retrieval?.fusionScore;

      const anchorsMatched = countMatches(corpus, context.anchors);
      const issuesMatched = countMatches(corpus, context.issues);
      const proceduresMatched = countMatches(corpus, context.procedures);
      const statutesMatched = countMatches(corpus, context.statutesOrSections);
      const proposition = evaluateChecklistCoverage({ text: corpus, evidenceText }, options?.checklist);

      const lexicalScore =
        blendedOverlap * 0.16 +
        mustIncludeOverlap * 0.08 +
        strictOverlap * 0.05 +
        checklistOverlap * 0.04;
      let rawScore = lexicalScore;
      const reasons: string[] = [];

      if (blendedOverlap > 0.16) {
        reasons.push(`Token overlap ${(blendedOverlap * 100).toFixed(0)}%`);
      }
      if (mustIncludeOverlap > 0.2) {
        reasons.push(`Canonical term overlap ${(mustIncludeOverlap * 100).toFixed(0)}%`);
      }
      if (strictOverlap > 0.2) {
        reasons.push(`Strict-query overlap ${(strictOverlap * 100).toFixed(0)}%`);
      }
      if (anchorsMatched > 0) {
        rawScore += Math.min(anchorsMatched * 0.018, 0.09);
        reasons.push(`Context anchors matched: ${anchorsMatched}`);
      }
      if (issuesMatched > 0) {
        rawScore += Math.min(issuesMatched * 0.05, 0.16);
        reasons.push(`Issue match count: ${issuesMatched}`);
      }
      if (proceduresMatched > 0) {
        rawScore += Math.min(proceduresMatched * 0.045, 0.12);
        reasons.push(`Procedure match count: ${proceduresMatched}`);
      }
      if (statutesMatched > 0) {
        rawScore += Math.min(statutesMatched * 0.03, 0.1);
        reasons.push(`Statute/section match count: ${statutesMatched}`);
      }

      if (options?.checklist) {
        if (proposition.requiredCoverage > 0) {
          rawScore += proposition.requiredCoverage * 0.26 * detailWeight;
          reasons.push(`Proposition coverage ${(proposition.requiredCoverage * 100).toFixed(0)}%`);
        }
        if (proposition.coreCoverage > 0) {
          rawScore += proposition.coreCoverage * 0.26 * detailWeight;
          reasons.push(`Core coverage ${(proposition.coreCoverage * 100).toFixed(0)}%`);
        }
        if (proposition.peripheralCoverage > 0) {
          rawScore += proposition.peripheralCoverage * 0.1 * detailWeight;
          reasons.push(`Peripheral coverage ${(proposition.peripheralCoverage * 100).toFixed(0)}%`);
        }
        if (proposition.hookGroupCoverage > 0) {
          rawScore += proposition.hookGroupCoverage * 0.2 * detailWeight;
          reasons.push(`Hook-group coverage ${(proposition.hookGroupCoverage * 100).toFixed(0)}%`);
        }
        if (proposition.relationSatisfied && options.checklist.relations.some((relation) => relation.required)) {
          rawScore += 0.08 * detailWeight;
          reasons.push("Required hook interaction satisfied");
        }
        if (proposition.outcomePolaritySatisfied && options.checklist.outcomeConstraint.required) {
          rawScore += 0.09 * detailWeight;
          reasons.push(`Outcome polarity matched (${options.checklist.outcomeConstraint.polarity})`);
        }
        if (proposition.matchedLabels.length > 0) {
          reasons.push(`Matched elements: ${proposition.matchedLabels.join(", ")}`);
        }
        if (proposition.missingLabels.length > 0) {
          reasons.push(`Missing elements: ${proposition.missingLabels.join(", ")}`);
        }
        if (!proposition.relationSatisfied && options.checklist.relations.some((relation) => relation.required)) {
          rawScore -= 0.16;
          reasons.push("Required hook interaction not satisfied");
        }
        if (proposition.polarityMismatch) {
          rawScore -= 0.24;
          reasons.push("Outcome polarity mismatch");
        }
        if (proposition.contradiction) {
          rawScore -= 0.32;
          reasons.push("Contradiction signal present against required outcome");
        }
        if (proposition.hookGroupCoverage < 1) {
          rawScore -= 0.1;
        }
      }

      const contradictionMatches = contradictionTokens.length > 0 ? countMatches(corpus, contradictionTokens) : 0;
      if (
        contradictionMatches > 0 &&
        proposition.requiredCoverage < 0.4 &&
        proposition.coreCoverage < 0.4 &&
        !proposition.outcomePolaritySatisfied
      ) {
        rawScore -= Math.min(0.22, contradictionMatches * 0.06);
        reasons.push(`Contradiction-only lexical drift (${contradictionMatches})`);
      }

      if (detailChecked) {
        rawScore += 0.05;
        reasons.push("Detail verified evidence");
      } else {
        rawScore -= 0.12;
        reasons.push("Detail not verified (down-ranked)");
      }

      if (typeof fusionScore === "number" && Number.isFinite(fusionScore)) {
        const boundedFusion = Math.max(0, Math.min(1, fusionScore * 8));
        rawScore += boundedFusion * 0.06;
        reasons.push(`Hybrid fusion signal ${(boundedFusion * 100).toFixed(0)}%`);
      }
      if (typeof rerankScore === "number" && Number.isFinite(rerankScore)) {
        rawScore += (Math.max(0, Math.min(1, rerankScore)) - 0.5) * 0.16;
        reasons.push(`Rerank signal ${(Math.max(0, Math.min(1, rerankScore)) * 100).toFixed(0)}%`);
      }

      if (provenance) {
        if (detailChecked && provenance.strictHits > 0 && provenance.bestUtility >= 0.55) {
          rawScore += 0.06;
          reasons.push("High-utility strict retrieval provenance");
        } else if (!detailChecked && provenance.strictHits === 0 && provenance.bestUtility < 0.25) {
          rawScore -= 0.08;
          reasons.push("Broad-only low-utility provenance penalty");
        }
      }

      if (candidate.court === "SC") {
        rawScore += 0.04;
        reasons.push("Supreme Court weighting");
      } else if (candidate.court === "HC") {
        rawScore += 0.03;
        reasons.push("High Court weighting");
      }

      if (typeof candidate.citedByCount === "number" && candidate.citedByCount >= 50) {
        rawScore += Math.min(candidate.citedByCount / 3000, 0.09);
        reasons.push(`Citation influence (cited by ${candidate.citedByCount})`);
      }
      if (typeof candidate.citesCount === "number" && candidate.citesCount >= 20) {
        rawScore += Math.min(candidate.citesCount / 2500, 0.04);
        reasons.push(`Authority signal (cites ${candidate.citesCount})`);
      }
      if (candidate.author && candidate.author.length > 2) {
        rawScore += 0.015;
        reasons.push("Author/judge metadata matched");
      }
      if (candidate.bench && candidate.bench.length > 2) {
        rawScore += 0.015;
        reasons.push("Bench metadata matched");
      }
      if (
        candidate.evidenceQuality?.hasRelationSentence ||
        candidate.evidenceQuality?.hasPolaritySentence ||
        candidate.evidenceQuality?.hasHookIntersectionSentence
      ) {
        rawScore += 0.03;
        reasons.push("Evidence-window authority signal");
      }

      const centered = (rawScore - 0.45) * 3.1;
      let rankingScore = clamp01(sigmoid(centered));
      rankingScore = Math.min(rankingScore, 0.92);
      if (
        provenance &&
        provenance.strictHits === 0 &&
        provenance.relaxedHits > 0 &&
        provenance.bestUtility < 0.25 &&
        !detailChecked
      ) {
        rankingScore = Math.min(rankingScore, 0.68);
        reasons.push("Confidence capped: broad-only low-utility retrieval");
      }
      if (provenance && provenance.strictHits > 0 && provenance.bestUtility >= 0.55 && detailChecked) {
        rankingScore = Math.min(0.94, rankingScore + 0.03);
      }

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
          detailChecked,
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
