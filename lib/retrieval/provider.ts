import { indianKanoonHtmlProvider } from "@/lib/retrieval/providers/indiankanoon";
import { serperProvider } from "@/lib/retrieval/providers/serper";
import { RetrievalProvider, RetrievalProviderId } from "@/lib/retrieval/providers/types";

export type RetrievalProviderMode = "auto" | RetrievalProviderId;

export type RetrievalProviderSelection = {
  configuredMode: RetrievalProviderMode;
  provider: RetrievalProvider;
  fallbackReason?: "serper_missing_key" | "invalid_mode";
  serperKeyPresent: boolean;
};

function parseConfiguredMode(value: string | undefined): RetrievalProviderMode | "invalid" {
  if (!value) return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "indiankanoon_html") return "indiankanoon_html";
  if (normalized === "serper") return "serper";
  return "invalid";
}

export function pickRetrievalProvider(): RetrievalProviderSelection {
  const parsedMode = parseConfiguredMode(process.env.RETRIEVAL_PROVIDER);
  const serperKeyPresent = Boolean(process.env.SERPER_API_KEY?.trim());

  if (parsedMode === "invalid") {
    return {
      configuredMode: "auto",
      provider: indianKanoonHtmlProvider,
      fallbackReason: "invalid_mode",
      serperKeyPresent,
    };
  }

  if (parsedMode === "indiankanoon_html") {
    return {
      configuredMode: parsedMode,
      provider: indianKanoonHtmlProvider,
      serperKeyPresent,
    };
  }

  if (parsedMode === "serper") {
    if (!serperKeyPresent) {
      return {
        configuredMode: parsedMode,
        provider: indianKanoonHtmlProvider,
        fallbackReason: "serper_missing_key",
        serperKeyPresent,
      };
    }
    return {
      configuredMode: parsedMode,
      provider: serperProvider,
      serperKeyPresent,
    };
  }

  const runningOnVercel = process.env.VERCEL === "1";
  if (runningOnVercel && serperKeyPresent) {
    return {
      configuredMode: "auto",
      provider: serperProvider,
      serperKeyPresent,
    };
  }

  return {
    configuredMode: "auto",
    provider: indianKanoonHtmlProvider,
    serperKeyPresent,
  };
}
