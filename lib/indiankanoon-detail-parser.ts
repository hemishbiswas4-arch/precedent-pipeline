import { IndianKanoonDetailArtifact, CourtLevel } from "@/lib/types";
import { stripHtmlTags } from "@/lib/indiankanoon-parser";

function parseIntSafe(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/,/g, "").trim();
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) ? asNumber : undefined;
}

function inferCourtLevel(text: string): CourtLevel {
  const lower = text.toLowerCase();
  if (lower.includes("supreme court")) return "SC";
  if (lower.includes("high court")) return "HC";
  return "UNKNOWN";
}

function splitEvidenceSentences(text: string): string[] {
  return text
    .split(/[\n.!?]+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 30);
}

function stripHtmlWithBreaks(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gim, " ")
    .replace(/<style[\s\S]*?<\/style>/gim, " ")
    .replace(/<\/(?:p|div|blockquote|pre|li|h[1-6]|tr|td)>/gim, "\n")
    .replace(/<br\s*\/?>/gim, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "\n");
}

function extractPreBlocks(html: string): string[] {
  const raw = Array.from(html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gim))
    .flatMap((match) => stripHtmlWithBreaks(match[1] ?? "").split(/\n+/))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 40);
  return raw.slice(0, 140);
}

function extractDenseBodyLines(html: string): string[] {
  const noiseCue =
    /(search engine for indian law|skip to main content|indiankanoon\.org|equivalent citations|author:|bench:|download pdf|login|sign in)/i;
  return stripHtmlWithBreaks(html)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 80)
    .filter((line) => !noiseCue.test(line))
    .slice(0, 80);
}

function extractEvidenceWindows(blocks: string[], limit: number): string[] {
  const relationCue = /(read with|vis[-\s]?a[-\s]?vis|interplay|interaction|requires under|applies to)/i;
  const polarityCue =
    /(required|not required|mandatory|necessary|refused|dismissed|rejected|not condoned|time barred|allowed|quashed)/i;
  const hookCue = /(section\s*\d+[a-z]?(?:\([0-9a-z]+\))?|crpc|ipc|cpc|prevention of corruption act|pc act|limitation act)/i;
  const roleCue =
    /(appellant|respondent|petitioner|accused|state of|government|prosecution|filed appeal|preferred appeal)/i;
  const chainCue = /(condonation of delay|delay condonation|application for condonation|not condoned|barred by limitation)/i;

  const windows: string[] = [];
  for (const block of blocks) {
    for (const sentence of splitEvidenceSentences(block)) {
      const relation = relationCue.test(sentence);
      const polarity = polarityCue.test(sentence);
      const hook = hookCue.test(sentence);
      const role = roleCue.test(sentence);
      const chain = chainCue.test(sentence);
      if (
        (relation && hook) ||
        (polarity && hook) ||
        (relation && polarity) ||
        (role && polarity) ||
        (chain && polarity)
      ) {
        windows.push(sentence);
      }
      if (windows.length >= limit) return windows;
    }
  }
  return windows;
}

export function parseIndianKanoonDetailPage(html: string): IndianKanoonDetailArtifact {
  const title = stripHtmlTags(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/im)?.[1] ?? "");
  const h3Matches = Array.from(html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gim))
    .map((m) => stripHtmlTags(m[1] ?? ""))
    .filter((line) => line.length > 0);

  const courtText = h3Matches.find((line) => /\bcourt\b/i.test(line)) ?? "";
  const equivalentCitations = h3Matches.find((line) => /^equivalent citations:/i.test(line)) ?? "";
  const authorLine = h3Matches.find((line) => /^author:/i.test(line)) ?? "";
  const benchLine = h3Matches.find((line) => /^bench:/i.test(line)) ?? "";

  const citesCount = parseIntSafe(html.match(/>\s*Cites\s*([0-9,]+)\s*</im)?.[1]);
  const citedByCount = parseIntSafe(html.match(/>\s*Cited\s*by\s*([0-9,]+)\s*</im)?.[1]);

  const preBlocks = extractPreBlocks(html);
  const blockquotes = Array.from(html.matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gim))
    .map((m) => stripHtmlTags(m[1] ?? ""))
    .filter((item) => item.length > 30)
    .slice(0, 80);

  const paragraphFallback =
    blockquotes.length > 0
      ? []
      : Array.from(html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gim))
          .map((m) => stripHtmlTags(m[1] ?? ""))
          .filter((item) => item.length > 40)
          .slice(0, 40);

  const denseFallback = preBlocks.length > 0 || blockquotes.length > 0 || paragraphFallback.length > 0
    ? []
    : extractDenseBodyLines(html);
  const bodyBlocks =
    preBlocks.length > 0
      ? preBlocks
      : blockquotes.length > 0
        ? blockquotes
        : paragraphFallback.length > 0
          ? paragraphFallback
          : denseFallback;
  const evidenceWindows = extractEvidenceWindows(bodyBlocks, 28);
  const bodyExcerpt = bodyBlocks.slice(0, 28);

  const combinedForCourt = `${courtText} ${title} ${bodyExcerpt.slice(0, 2).join(" ")}`.trim();
  const court = inferCourtLevel(combinedForCourt);

  return {
    title: title || undefined,
    courtText: courtText || undefined,
    court,
    equivalentCitations: equivalentCitations
      ? equivalentCitations.replace(/^equivalent citations:\s*/i, "").trim()
      : undefined,
    author: authorLine ? authorLine.replace(/^author:\s*/i, "").trim() : undefined,
    bench: benchLine ? benchLine.replace(/^bench:\s*/i, "").trim() : undefined,
    citesCount,
    citedByCount,
    evidenceWindows,
    bodyExcerpt,
  };
}

export function detailArtifactToText(artifact: IndianKanoonDetailArtifact): string {
  const parts = [
    artifact.title ? `Title: ${artifact.title}` : "",
    artifact.courtText ? `Court: ${artifact.courtText}` : "",
    artifact.equivalentCitations ? `Equivalent citations: ${artifact.equivalentCitations}` : "",
    artifact.author ? `Author: ${artifact.author}` : "",
    artifact.bench ? `Bench: ${artifact.bench}` : "",
    typeof artifact.citesCount === "number" ? `Cites count: ${artifact.citesCount}` : "",
    typeof artifact.citedByCount === "number" ? `Cited by count: ${artifact.citedByCount}` : "",
    artifact.evidenceWindows.length > 0 ? `Evidence windows:\n${artifact.evidenceWindows.join("\n")}` : "",
    artifact.bodyExcerpt.length > 0 ? `Body:\n${artifact.bodyExcerpt.join("\n")}` : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  return parts.slice(0, 12000);
}
