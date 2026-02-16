export type SearchRuntimeProfile = "fast_balanced" | "recall_max" | "latency_first";

type ProfileSettings = {
  pipelineMaxElapsedMs: {
    defaultValue: number;
    cap: number;
    min: number;
  };
  defaultGlobalBudget: {
    defaultValue: number;
    cap: number;
    min: number;
  };
  guaranteeExtraAttempts: {
    defaultValue: number;
    cap: number;
    min: number;
  };
  llmReasonerTimeoutMs: {
    defaultValue: number;
    cap: number;
    min: number;
  };
  llmReasonerMaxCallsPerRequest: {
    defaultValue: number;
    cap: number;
    min: number;
  };
};

const PROFILE_SETTINGS: Record<SearchRuntimeProfile, ProfileSettings> = {
  fast_balanced: {
    pipelineMaxElapsedMs: {
      defaultValue: 12_000,
      cap: 12_000,
      min: 5_000,
    },
    defaultGlobalBudget: {
      defaultValue: 6,
      cap: 6,
      min: 4,
    },
    guaranteeExtraAttempts: {
      defaultValue: 1,
      cap: 1,
      min: 1,
    },
    llmReasonerTimeoutMs: {
      defaultValue: 3_500,
      cap: 3_500,
      min: 200,
    },
    llmReasonerMaxCallsPerRequest: {
      defaultValue: 1,
      cap: 1,
      min: 0,
    },
  },
  recall_max: {
    pipelineMaxElapsedMs: {
      defaultValue: 20_000,
      cap: 35_000,
      min: 5_000,
    },
    defaultGlobalBudget: {
      defaultValue: 10,
      cap: 14,
      min: 4,
    },
    guaranteeExtraAttempts: {
      defaultValue: 2,
      cap: 4,
      min: 1,
    },
    llmReasonerTimeoutMs: {
      defaultValue: 5_500,
      cap: 8_000,
      min: 200,
    },
    llmReasonerMaxCallsPerRequest: {
      defaultValue: 2,
      cap: 2,
      min: 0,
    },
  },
  latency_first: {
    pipelineMaxElapsedMs: {
      defaultValue: 8_000,
      cap: 10_000,
      min: 5_000,
    },
    defaultGlobalBudget: {
      defaultValue: 5,
      cap: 5,
      min: 4,
    },
    guaranteeExtraAttempts: {
      defaultValue: 1,
      cap: 1,
      min: 1,
    },
    llmReasonerTimeoutMs: {
      defaultValue: 2_400,
      cap: 2_800,
      min: 200,
    },
    llmReasonerMaxCallsPerRequest: {
      defaultValue: 1,
      cap: 1,
      min: 0,
    },
  },
};

export function parseSearchRuntimeProfile(value: string | undefined): SearchRuntimeProfile {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "recall_max") return "recall_max";
  if (normalized === "latency_first") return "latency_first";
  return "fast_balanced";
}

export function getSearchRuntimeProfileSettings(profile: SearchRuntimeProfile): ProfileSettings {
  return PROFILE_SETTINGS[profile];
}

export function resolveProfiledNumber(input: {
  value: string | undefined;
  defaultValue: number;
  min?: number;
  cap?: number;
  round?: "floor" | "none";
}): number {
  const parsed = Number(input.value ?? "");
  let output = Number.isFinite(parsed) ? parsed : input.defaultValue;
  if (input.round === "floor") output = Math.floor(output);
  if (typeof input.min === "number") output = Math.max(output, input.min);
  if (typeof input.cap === "number") output = Math.min(output, input.cap);
  return output;
}
