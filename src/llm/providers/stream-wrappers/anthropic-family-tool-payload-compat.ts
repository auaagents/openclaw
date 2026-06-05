// Anthropic-family tool payload compatibility wraps provider tool payload shapes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { StreamFn } from "../../../agents/runtime/index.js";
import { streamSimple } from "../../stream.js";
type AnthropicToolSchemaMode = "openai-functions";
type AnthropicToolChoiceMode = "openai-string-modes";

type AnthropicToolPayloadCompatibilityOptions = {
  toolSchemaMode?: AnthropicToolSchemaMode;
  toolChoiceMode?: AnthropicToolChoiceMode;
};

type PayloadFieldRead = { ok: true; value: unknown } | { ok: false };

function readPayloadField(record: Record<string, unknown>, key: string): PayloadFieldRead {
  try {
    return { ok: true, value: record[key] };
  } catch {
    return { ok: false };
  }
}

function deletePayloadField(record: Record<string, unknown>, key: string): void {
  try {
    delete record[key];
  } catch {
    // Best-effort compatibility cleanup must not abort the provider turn.
  }
}

function readModelField(model: unknown, key: string): unknown {
  if (!model || typeof model !== "object") {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(model, key);
  } catch {
    return undefined;
  }
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function readCompatField(model: unknown, key: string): unknown {
  const compat = readModelField(model, "compat");
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    return undefined;
  }
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(compat, key);
  } catch {
    return undefined;
  }
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function hasOpenAiAnthropicToolPayloadCompatFlag(model: { compat?: unknown }): boolean {
  return readCompatField(model, "requiresOpenAiAnthropicToolPayload") === true;
}

function requiresAnthropicToolPayloadCompatibilityForModel(
  model: {
    api?: unknown;
    compat?: unknown;
  },
  options?: AnthropicToolPayloadCompatibilityOptions,
): boolean {
  if (readModelField(model, "api") !== "anthropic-messages") {
    return false;
  }
  return (
    Boolean(options?.toolSchemaMode || options?.toolChoiceMode) ||
    hasOpenAiAnthropicToolPayloadCompatFlag(model)
  );
}

function usesOpenAiFunctionAnthropicToolSchemaForModel(
  model: {
    compat?: unknown;
  },
  options?: AnthropicToolPayloadCompatibilityOptions,
): boolean {
  return (
    options?.toolSchemaMode === "openai-functions" || hasOpenAiAnthropicToolPayloadCompatFlag(model)
  );
}

function usesOpenAiStringModeAnthropicToolChoiceForModel(
  model: {
    compat?: unknown;
  },
  options?: AnthropicToolPayloadCompatibilityOptions,
): boolean {
  return (
    options?.toolChoiceMode === "openai-string-modes" ||
    hasOpenAiAnthropicToolPayloadCompatFlag(model)
  );
}

function normalizeOpenAiFunctionAnthropicToolDefinition(
  tool: unknown,
): Record<string, unknown> | undefined {
  try {
    return normalizeOpenAiFunctionAnthropicToolDefinitionUnsafe(tool);
  } catch {
    return undefined;
  }
}

function normalizeOpenAiFunctionAnthropicToolDefinitionUnsafe(
  tool: unknown,
): Record<string, unknown> | undefined {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return undefined;
  }

  const toolObj = tool as Record<string, unknown>;
  const existingFunction = toolObj.function;
  if (existingFunction && typeof existingFunction === "object") {
    return toolObj;
  }

  const rawName = normalizeOptionalString(toolObj.name) ?? "";
  if (!rawName) {
    return toolObj;
  }
  const inputSchema = toolObj.input_schema;
  const parameters = toolObj.parameters;
  const description = toolObj.description;
  const strict = toolObj.strict;

  const functionSpec: Record<string, unknown> = {
    name: rawName,
    parameters:
      inputSchema && typeof inputSchema === "object"
        ? inputSchema
        : parameters && typeof parameters === "object"
          ? parameters
          : { type: "object", properties: {} },
  };

  if (typeof description === "string" && description.trim()) {
    functionSpec.description = description;
  }
  if (typeof strict === "boolean") {
    functionSpec.strict = strict;
  }

  return {
    type: "function",
    function: functionSpec,
  };
}

function normalizeOpenAiStringModeAnthropicToolChoice(toolChoice: unknown): unknown {
  try {
    return normalizeOpenAiStringModeAnthropicToolChoiceUnsafe(toolChoice);
  } catch {
    return undefined;
  }
}

function normalizeOpenAiStringModeAnthropicToolChoiceUnsafe(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== "object" || Array.isArray(toolChoice)) {
    return toolChoice;
  }

  const choice = toolChoice as Record<string, unknown>;
  const type = choice.type;
  if (type === "auto") {
    return "auto";
  }
  if (type === "none") {
    return "none";
  }
  if (type === "required" || type === "any") {
    return "required";
  }
  const name = choice.name;
  if (type === "tool" && typeof name === "string" && name.trim()) {
    return {
      type: "function",
      function: { name: name.trim() },
    };
  }

  return toolChoice;
}

/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export function createAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
  options?: AnthropicToolPayloadCompatibilityOptions,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, streamOptions) => {
    const originalOnPayload = streamOptions?.onPayload;
    return underlying(model, context, {
      ...streamOptions,
      onPayload: (payload) => {
        if (
          payload &&
          typeof payload === "object" &&
          requiresAnthropicToolPayloadCompatibilityForModel(model, options)
        ) {
          const payloadObj = payload as Record<string, unknown>;
          const tools = readPayloadField(payloadObj, "tools");
          if (
            tools.ok &&
            Array.isArray(tools.value) &&
            usesOpenAiFunctionAnthropicToolSchemaForModel(model, options)
          ) {
            payloadObj.tools = tools.value
              .map((tool) => normalizeOpenAiFunctionAnthropicToolDefinition(tool))
              .filter((tool): tool is Record<string, unknown> => Boolean(tool));
          } else if (!tools.ok) {
            deletePayloadField(payloadObj, "tools");
          }
          if (usesOpenAiStringModeAnthropicToolChoiceForModel(model, options)) {
            const toolChoice = readPayloadField(payloadObj, "tool_choice");
            if (toolChoice.ok) {
              payloadObj.tool_choice = normalizeOpenAiStringModeAnthropicToolChoice(
                toolChoice.value,
              );
            } else {
              deletePayloadField(payloadObj, "tool_choice");
            }
          }
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}

/** @deprecated Anthropic-family provider stream helper; do not use from third-party plugins. */
export function createOpenAIAnthropicToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  return createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn, {
    toolSchemaMode: "openai-functions",
    toolChoiceMode: "openai-string-modes",
  });
}
