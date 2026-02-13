import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

export type BedrockModelConfig =
  | { ok: true; modelId: string; debugModelId: string; region: string }
  | { ok: false; error: string; debugModelId?: string; region: string };

const bedrockClientsByRegion = new Map<string, BedrockRuntimeClient>();

const DEFAULT_REGION = "ap-southeast-1";

export function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function isInferenceProfileArn(value: string): boolean {
  return /^arn:aws(?:-[a-z]+)?:bedrock:[a-z0-9-]+:\d{12}:inference-profile\/[A-Za-z0-9._:/-]+$/i.test(
    value,
  );
}

function isFoundationModelArn(value: string): boolean {
  return /^arn:aws(?:-[a-z]+)?:bedrock:[a-z0-9-]+:(?:\d{12})?:foundation-model\/[A-Za-z0-9._:/-]+$/i.test(
    value,
  );
}

export function parseRegionFromBedrockArn(value: string): string | null {
  if (!value.startsWith("arn:")) return null;
  const match = value.match(/^arn:aws(?:-[a-z]+)?:bedrock:([a-z0-9-]+):/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export function isValidBedrockModelId(value: string): boolean {
  const modelIdPattern = /^[a-z0-9][a-z0-9._:-]{2,}$/i;
  if (looksLikeJwt(value)) {
    return false;
  }
  return isInferenceProfileArn(value) || isFoundationModelArn(value) || modelIdPattern.test(value);
}

export function toDebugModelId(modelId: string): string {
  if (modelId.startsWith("arn:")) {
    const resource = modelId.split(":").slice(5).join(":");
    const [resourceType = "arn", rest = ""] = resource.split("/");
    const suffix = rest || resource;
    return `${resourceType}:${suffix}`;
  }
  if (looksLikeJwt(modelId)) {
    return "invalid-configured-value";
  }
  if (modelId.length > 72) {
    return `${modelId.slice(0, 28)}...${modelId.slice(-16)}`;
  }
  return modelId;
}

function resolveRegion(modelId?: string, regionOverride?: string): string {
  const parsedFromModel = modelId ? parseRegionFromBedrockArn(modelId) : null;
  return (
    regionOverride?.trim() ||
    parsedFromModel ||
    process.env.AWS_REGION?.trim() ||
    DEFAULT_REGION
  );
}

export function getBedrockModelConfig(options: {
  envKey?: string;
  fallbackEnvKey?: string;
}): BedrockModelConfig {
  const primary = options.envKey ? process.env[options.envKey]?.trim() : undefined;
  const fallback = options.fallbackEnvKey ? process.env[options.fallbackEnvKey]?.trim() : undefined;
  const modelId = primary || fallback;

  if (!modelId) {
    const source = [options.envKey, options.fallbackEnvKey].filter(Boolean).join(" or ");
    return {
      ok: false,
      error: `${source || "model id"} missing`,
      region: resolveRegion(undefined),
    };
  }

  if (!isValidBedrockModelId(modelId)) {
    return {
      ok: false,
      error: `${options.envKey ?? "model id"} is not a valid Bedrock model/inference profile id`,
      debugModelId: toDebugModelId(modelId),
      region: resolveRegion(modelId),
    };
  }

  return {
    ok: true,
    modelId,
    debugModelId: toDebugModelId(modelId),
    region: resolveRegion(modelId),
  };
}

export function getBedrockClient(options?: { region?: string; modelId?: string }): BedrockRuntimeClient {
  // Avoid slow credential resolution attempts against IMDS in non-AWS environments (e.g. Vercel),
  // which can otherwise look like "Bedrock timeout" in our tight latency budgets.
  if (!process.env.AWS_EC2_METADATA_DISABLED) {
    process.env.AWS_EC2_METADATA_DISABLED = "true";
  }

  const region = resolveRegion(options?.modelId, options?.region);
  const cached = bedrockClientsByRegion.get(region);
  if (cached) {
    return cached;
  }

  const client = new BedrockRuntimeClient({
    region,
    // Keep Bedrock calls bounded; our pipeline handles retries/fallbacks at a higher level.
    maxAttempts: 1,
  });
  bedrockClientsByRegion.set(region, client);
  return client;
}
