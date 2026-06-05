// Anthropic-family payload compatibility tests cover provider payload projection.
import { describe, expect, it } from "vitest";
import type { StreamFn } from "../../../agents/runtime/index.js";
import {
  createAnthropicToolPayloadCompatibilityWrapper,
  createOpenAIAnthropicToolPayloadCompatibilityWrapper,
} from "./anthropic-family-tool-payload-compat.js";

function runAnthropicPayloadWrapper(
  payload: Record<string, unknown>,
  modelOverride?: unknown,
): void {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload, {} as never);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = createOpenAIAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);

  void wrapped(
    (modelOverride ?? {
      api: "anthropic-messages",
      provider: "openai-compatible-anthropic",
      id: "compat-model",
      compat: { requiresOpenAiAnthropicToolPayload: true },
    }) as never,
    { messages: [] } as never,
    {},
  );
}

function runGenericAnthropicPayloadWrapper(payload: Record<string, unknown>, model: unknown): void {
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload, {} as never);
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = createAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);

  void wrapped(model as never, { messages: [] } as never, {});
}

describe("createOpenAIAnthropicToolPayloadCompatibilityWrapper", () => {
  it("skips unreadable tool rows while preserving healthy converted tools", () => {
    const unreadableName = {};
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("raw name getter");
      },
    });
    const unreadableSchema = { name: "poisoned" };
    Object.defineProperty(unreadableSchema, "input_schema", {
      enumerable: true,
      get() {
        throw new Error("raw schema getter");
      },
    });
    const payload = {
      tools: [
        unreadableName,
        unreadableSchema,
        {
          name: "lookup",
          description: "Lookup docs",
          input_schema: { type: "object", properties: { query: { type: "string" } } },
          strict: true,
        },
      ],
    };

    runAnthropicPayloadWrapper(payload);

    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup docs",
          parameters: { type: "object", properties: { query: { type: "string" } } },
          strict: true,
        },
      },
    ]);
  });

  it("drops unreadable payload fields instead of crashing compatibility cleanup", () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "tools", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("raw tools getter");
      },
    });
    Object.defineProperty(payload, "tool_choice", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("raw tool choice getter");
      },
    });

    runAnthropicPayloadWrapper(payload);

    expect(Object.hasOwn(payload, "tools")).toBe(false);
    expect(Object.hasOwn(payload, "tool_choice")).toBe(false);
  });

  it("ignores hostile model api accessors before payload conversion", () => {
    const model = {
      compat: { requiresOpenAiAnthropicToolPayload: true },
      id: "compat-model",
      provider: "openai-compatible-anthropic",
    };
    Object.defineProperty(model, "api", {
      enumerable: true,
      get() {
        throw new Error("model api getter should not run");
      },
    });
    const payload = {
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    };

    expect(() => runGenericAnthropicPayloadWrapper(payload, model)).not.toThrow();

    expect(payload.tools).toEqual([
      { name: "lookup", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("ignores hostile model compat accessors before payload conversion", () => {
    const model = {
      api: "anthropic-messages",
      id: "compat-model",
      provider: "openai-compatible-anthropic",
    };
    Object.defineProperty(model, "compat", {
      enumerable: true,
      get() {
        throw new Error("model compat getter should not run");
      },
    });
    const payload = {
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    };

    expect(() => runGenericAnthropicPayloadWrapper(payload, model)).not.toThrow();

    expect(payload.tools).toEqual([
      { name: "lookup", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("ignores hostile compat flag accessors before payload conversion", () => {
    const compat = {};
    Object.defineProperty(compat, "requiresOpenAiAnthropicToolPayload", {
      enumerable: true,
      get() {
        throw new Error("compat flag getter should not run");
      },
    });
    const payload = {
      tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    };

    expect(() =>
      runGenericAnthropicPayloadWrapper(payload, {
        api: "anthropic-messages",
        compat,
        id: "compat-model",
        provider: "openai-compatible-anthropic",
      }),
    ).not.toThrow();

    expect(payload.tools).toEqual([
      { name: "lookup", input_schema: { type: "object", properties: {} } },
    ]);
  });
});
