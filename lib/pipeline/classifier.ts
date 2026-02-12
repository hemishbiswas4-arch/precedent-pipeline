import { CaseCandidate, CandidateKind } from "@/lib/types";
import { CandidateClassification, ClassifiedCandidate } from "@/lib/pipeline/types";

function isStatuteLike(text: string): boolean {
  return (
    /\bconstitution of india\b/.test(text) ||
    /\bindian penal code\b/.test(text) ||
    /\bcode of criminal procedure\b/.test(text) ||
    /\bact,\s*\d{4}\b/.test(text) ||
    /\bcode,\s*\d{4}\b/.test(text) ||
    /\brules,\s*\d{4}\b/.test(text) ||
    /\bsection\s+\d+[a-z]?\b[\s\S]{0,70}\b(?:punishment|whoever|shall be punished)\b/.test(text)
  );
}

function isStatuteLikeTitle(title: string): boolean {
  return (
    /\bconstitution of india\b/.test(title) ||
    /\b(indian penal code|code of criminal procedure)\b/.test(title) ||
    /\bact,\s*\d{4}\b/.test(title) ||
    /\bcode,\s*\d{4}\b/.test(title) ||
    /\brules,\s*\d{4}\b/.test(title)
  );
}

function isCaseLike(text: string): boolean {
  return (
    /\b v(?:s\.?|\.?) \b/.test(text) ||
    /\bon\s+\d{1,2}\s+[a-z]{3,9}\s+\d{4}\b/.test(text) ||
    /\b(?:petitioner|respondent|appellant|appeal|criminal appeal|writ petition|judgment)\b/.test(
      text,
    )
  );
}

export function classifyCandidate(candidate: CaseCandidate): CandidateClassification {
  const text = `${candidate.title} ${candidate.snippet} ${candidate.detailText ?? ""}`.toLowerCase();
  const title = (candidate.title || "").toLowerCase().trim();
  const titleCaseLike = isCaseLike(title);
  const bodyCaseLike = isCaseLike(text);
  const titleStatuteLike = isStatuteLikeTitle(title);
  const bodyStatuteLike = isStatuteLike(text);
  const reasons: string[] = [];

  if (!title || /^(search|full document|similar judgments?)$/.test(title)) {
    reasons.push("pseudo-result title");
    return { kind: "noise", reasons };
  }

  if (titleCaseLike || (bodyCaseLike && !titleStatuteLike)) {
    reasons.push("case-law signals");
    return { kind: "case", reasons };
  }

  if (titleStatuteLike || bodyStatuteLike) {
    reasons.push("statute-like body");
    return { kind: "statute", reasons };
  }

  if (bodyCaseLike) {
    reasons.push("case-law signals");
    return { kind: "case", reasons };
  }

  if (candidate.court !== "UNKNOWN" && title.length > 8) {
    reasons.push("court-tagged candidate");
    return { kind: "unknown", reasons };
  }

  reasons.push("insufficient legal case signals");
  return { kind: "noise", reasons };
}

export function classifyCandidates(candidates: CaseCandidate[]): ClassifiedCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    classification: classifyCandidate(candidate),
  }));
}

export function classificationCounts(items: ClassifiedCandidate[]): Record<CandidateKind, number> {
  return items.reduce<Record<CandidateKind, number>>(
    (acc, item) => {
      acc[item.classification.kind] += 1;
      return acc;
    },
    { case: 0, statute: 0, noise: 0, unknown: 0 },
  );
}
