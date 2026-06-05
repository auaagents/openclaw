// Agent Core failure-message helpers keep terminal error reporting best-effort.
import type { AssistantMessage, Model } from "../../llm-core/src/index.js";

function createEmptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function readFailureModelString(model: Model, key: "api" | "provider" | "id"): string {
  try {
    const value = model[key];
    return typeof value === "string" && value.length > 0 ? value : "unknown";
  } catch {
    return "unknown";
  }
}

export function formatAgentFailureErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown agent failure";
  }
}

export function createAgentFailureMessage(
  model: Model,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: readFailureModelString(model, "api"),
    provider: readFailureModelString(model, "provider"),
    model: readFailureModelString(model, "id"),
    usage: createEmptyUsage(),
    stopReason: aborted ? "aborted" : "error",
    errorMessage: formatAgentFailureErrorMessage(error),
    timestamp: Date.now(),
  };
}
