import { NextRequest, NextResponse } from "next/server";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { getBedrockClient, getBedrockModelConfig } from "@/lib/bedrock-client";

export const runtime = "nodejs";

const HEALTH_OPTIMIZED_LATENCY_ENABLED = (process.env.BEDROCK_HEALTH_OPTIMIZED_LATENCY ?? "1") !== "0";

function parseTimeoutMs(req: NextRequest): number {
  const raw = req.nextUrl.searchParams.get("timeoutMs");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return Math.max(1_500, Number(process.env.BEDROCK_HEALTH_TIMEOUT_MS ?? "7000"));
  }
  return Math.max(1_500, Math.min(Math.floor(parsed), 15_000));
}

function readHttpStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  const status = metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function inferHint(input: {
  message: string;
  name?: string;
  httpStatusCode?: number;
}): string | undefined {
  const message = input.message.toLowerCase();
  const name = (input.name ?? "").toLowerCase();
  if (name.includes("abort") || /request aborted|timed out|timeout|aborted/i.test(message)) {
    return "Bedrock probe timed out. Increase BEDROCK_HEALTH_TIMEOUT_MS (for example 9000) and verify region/model alignment.";
  }
  if (
    input.httpStatusCode === 404 ||
    /model/i.test(message) &&
      /(not found|unknown|could not resolve|does not exist|invalid)/i.test(message)
  ) {
    return "Model and Bedrock region may be mismatched. Verify the model ID/ARN and region align.";
  }
  if (name.includes("validation") || /validationexception/i.test(message)) {
    return "Request was rejected by Bedrock validation. Confirm model ID format and request schema.";
  }
  if (name.includes("accessdenied") || /access denied|not authorized|not authorized to perform/i.test(message)) {
    return "IAM permissions are insufficient. Check bedrock:InvokeModel / bedrock:InvokeModelWithResponseStream for this model.";
  }
  if (/security token|credential|expiredtoken|invalidclienttokenid/i.test(message)) {
    return "AWS credentials appear invalid or expired in this runtime.";
  }
  return undefined;
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const modelConfig = getBedrockModelConfig({
    envKey: "LLM_REASONER_MODEL_ID",
    fallbackEnvKey: "BEDROCK_INFERENCE_PROFILE_ARN",
  });

  const region = modelConfig.region;
  if (!modelConfig.ok) {
    return NextResponse.json(
      {
        ok: false,
        region,
        modelId: modelConfig.debugModelId ?? null,
        error: modelConfig.error,
        hint: "Set LLM_REASONER_MODEL_ID or BEDROCK_INFERENCE_PROFILE_ARN and verify AWS_REGION/ARN region alignment.",
      },
      { status: 500 },
    );
  }

  const controller = new AbortController();
  const timeoutMs = parseTimeoutMs(req);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseInput = {
      modelId: modelConfig.modelId,
      system: [{ text: "Return strict JSON only." }],
      messages: [
        {
          role: "user" as const,
          content: [
            {
              text: JSON.stringify({
                ping: true,
                task: "Return {\"ok\":true}.",
              }),
            },
          ],
        },
      ],
      inferenceConfig: {
        maxTokens: 16,
        temperature: 0,
      },
    };

    const sendOnce = async (optimized: boolean) => {
      const cmd = new ConverseCommand({
        ...baseInput,
        ...(optimized ? { performanceConfig: { latency: "optimized" as const } } : {}),
      });
      return await getBedrockClient({ modelId: modelConfig.modelId }).send(cmd, {
        abortSignal: controller.signal,
      });
    };

    const isUnsupportedConfigError = (error: unknown): boolean => {
      const name = error instanceof Error ? error.name.toLowerCase() : "";
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!name.includes("validation") && !message.includes("validation")) return false;
      return message.includes("performanceconfig") || message.includes("latency");
    };

    let response;
    try {
      response = await sendOnce(HEALTH_OPTIMIZED_LATENCY_ENABLED);
    } catch (error) {
      if (!HEALTH_OPTIMIZED_LATENCY_ENABLED || !isUnsupportedConfigError(error)) {
        throw error;
      }
      response = await sendOnce(false);
    }

    const text = (response.output?.message?.content ?? [])
      .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
      .join("\n")
      .trim();

    return NextResponse.json({
      ok: true,
      region,
      modelId: modelConfig.debugModelId,
      latencyMs: Date.now() - startedAt,
      preview: text.slice(0, 160),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const errorName = error instanceof Error ? error.name : undefined;
    const aborted =
      (errorName ?? "").toLowerCase().includes("abort") ||
      /request aborted|timed out|timeout|aborted/i.test(message);
    const httpStatusCode = readHttpStatusCode(error);
    const normalizedError = aborted ? `bedrock_health_timeout:${timeoutMs}` : message;
    const hint = inferHint({
      message: normalizedError,
      name: errorName,
      httpStatusCode,
    });
    return NextResponse.json(
      {
        ok: false,
        region,
        modelId: modelConfig.debugModelId,
        latencyMs: Date.now() - startedAt,
        timeoutMs,
        aborted,
        errorName,
        httpStatusCode,
        hint,
        error: normalizedError,
      },
      { status: aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}
