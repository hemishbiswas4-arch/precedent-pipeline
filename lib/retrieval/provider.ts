import { indianKanoonApiProvider } from "@/lib/retrieval/providers/indiankanoon-api";
import { indianKanoonHtmlProvider } from "@/lib/retrieval/providers/indiankanoon";
import { serperProvider } from "@/lib/retrieval/providers/serper";
import { RetrievalProvider, RetrievalProviderId } from "@/lib/retrieval/providers/types";

export type RetrievalProviderMode = "auto" | RetrievalProviderId;

export type RetrievalProviderSelection = {
  configuredMode: RetrievalProviderMode;
  provider: RetrievalProvider;
  fallbackReason?: "serper_missing_key" | "ik_api_missing_config" | "invalid_mode";
  serperKeyPresent: boolean;
  ikApiConfigured: boolean;
};

function parseConfiguredMode(value: string | undefined): RetrievalProviderMode | "invalid" {
  if (!value) return "auto";
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "indiankanoon_api") return "indiankanoon_api";
  if (normalized === "indiankanoon_html") return "indiankanoon_html";
  if (normalized === "serper") return "serper";
  return "invalid";
}

export function pickRetrievalProvider(): RetrievalProviderSelection {
  const parsedMode = parseConfiguredMode(process.env.RETRIEVAL_PROVIDER);
  const serperKeyPresent = Boolean(process.env.SERPER_API_KEY?.trim());
  const ikApiConfigured = Boolean(process.env.IK_API_BASE_URL?.trim() && process.env.IK_API_KEY?.trim());

  if (parsedMode === "invalid") {
    return {
      configuredMode: "auto",
      provider: ikApiConfigured ? indianKanoonApiProvider : indianKanoonHtmlProvider,
      fallbackReason: "invalid_mode",
      serperKeyPresent,
      ikApiConfigured,
    };
  }

  if (parsedMode === "indiankanoon_api") {
    if (!ikApiConfigured) {
      return {
        configuredMode: parsedMode,
        provider: indianKanoonHtmlProvider,
        fallbackReason: "ik_api_missing_config",
        serperKeyPresent,
        ikApiConfigured,
      };
    }
    return {
      configuredMode: parsedMode,
      provider: indianKanoonApiProvider,
      serperKeyPresent,
      ikApiConfigured,
    };
  }

  if (parsedMode === "indiankanoon_html") {
    return {
      configuredMode: parsedMode,
      provider: indianKanoonHtmlProvider,
      serperKeyPresent,
      ikApiConfigured,
    };
  }

  if (parsedMode === "serper") {
    if (!serperKeyPresent) {
      return {
        configuredMode: parsedMode,
        provider: indianKanoonHtmlProvider,
        fallbackReason: "serper_missing_key",
        serperKeyPresent,
        ikApiConfigured,
      };
    }
    return {
      configuredMode: parsedMode,
      provider: serperProvider,
      serperKeyPresent,
      ikApiConfigured,
    };
  }

  if (ikApiConfigured) {
    return {
      configuredMode: "auto",
      provider: indianKanoonApiProvider,
      serperKeyPresent,
      ikApiConfigured,
    };
  }

  const runningOnVercel = process.env.VERCEL === "1";
  if (runningOnVercel && serperKeyPresent) {
    return {
      configuredMode: "auto",
      provider: serperProvider,
      serperKeyPresent,
      ikApiConfigured,
    };
  }

  return {
    configuredMode: "auto",
    provider: indianKanoonHtmlProvider,
    serperKeyPresent,
    ikApiConfigured,
  };
}
