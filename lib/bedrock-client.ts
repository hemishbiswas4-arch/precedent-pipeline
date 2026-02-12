import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

export type BedrockModelConfig =
  | { ok: true; modelId: string; debugModelId: string }
  | { ok: false; error: string; debugModelId?: string };

let bedrockClient: BedrockRuntimeClient | null = null;

export function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function isValidBedrockModelId(value: string): boolean {
  const arnPattern = /^arn:aws(-[a-z]+)?:bedrock:[a-z0-9-]+:\d{12}:inference-profile\/[A-Za-z0-9._:-]+$/i;
  const modelIdPattern = /^[a-z0-9][a-z0-9._:-]{2,}$/i;
  if (looksLikeJwt(value)) {
    return false;
  }
  return arnPattern.test(value) || modelIdPattern.test(value);
}

export function toDebugModelId(modelId: string): string {
  if (modelId.startsWith("arn:")) {
    const suffix = modelId.split("/").pop() ?? modelId;
    return `inference-profile:${suffix}`;
  }
  if (looksLikeJwt(modelId)) {
    return "invalid-configured-value";
  }
  if (modelId.length > 72) {
    return `${modelId.slice(0, 28)}...${modelId.slice(-16)}`;
  }
  return modelId;
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
    };
  }

  if (!isValidBedrockModelId(modelId)) {
    return {
      ok: false,
      error: `${options.envKey ?? "model id"} is not a valid Bedrock model/inference profile id`,
      debugModelId: toDebugModelId(modelId),
    };
  }

  return {
    ok: true,
    modelId,
    debugModelId: toDebugModelId(modelId),
  };
}

export function getBedrockClient(): BedrockRuntimeClient {
  if (bedrockClient) {
    return bedrockClient;
  }

  bedrockClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || "ap-southeast-1",
  });

  return bedrockClient;
}
