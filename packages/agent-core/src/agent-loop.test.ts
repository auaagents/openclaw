// Agent Core tests cover agent loop behavior.
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLoop, agentLoopContinue } from "./agent-loop.js";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type ToolResultMessage,
} from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

function makeHostileModel(): Model {
  const hostile = { ...model };
  for (const key of ["api", "provider", "id"] as const) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() {
        throw new Error(`revoked ${key}`);
      },
    });
  }
  return hostile;
}

const failingStreamFn: StreamFn = async () => {
  throw new Error("provider exploded");
};

const assistantMessage: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 1,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function expectTerminalFailure(events: AgentEvent[], result: AgentMessage[]): void {
  expect(events.map((event) => event.type)).toContain("agent_end");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    role: "assistant",
    stopReason: "error",
    errorMessage: "provider exploded",
  });
}

async function collectEventsWithTimeout(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collectEvents(stream),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("agent loop stream did not settle")), 500);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function createTool(name: string, parameters = Type.Object({ query: Type.String() })): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters,
    execute: async () => ({
      content: [{ type: "text", text: "done" }],
      details: {},
    }),
  };
}

function createStreamFn(contexts: Context[]): StreamFn {
  return (_model, context) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message: assistantMessage });
    return stream;
  };
}

function createToolCallThenDoneStreamFn(): StreamFn {
  let callCount = 0;
  return () => {
    callCount += 1;
    const stream = createAssistantMessageEventStream();
    if (callCount === 1) {
      stream.push({
        type: "done",
        reason: "tool_call",
        message: {
          ...assistantMessage,
          content: [
            {
              type: "toolCall",
              id: "call_poison",
              name: "poison_tool",
              arguments: { query: "hello" },
            },
          ],
          stopReason: "tool_call",
        },
      });
      return stream;
    }
    stream.push({ type: "done", reason: "stop", message: assistantMessage });
    return stream;
  };
}

function createPoisonedStringificationError(): unknown {
  return {
    toString() {
      throw new Error("stringify exploded");
    },
  };
}

function findToolResult(events: AgentEvent[]): ToolResultMessage | undefined {
  return events.find(
    (event): event is Extract<AgentEvent, { type: "message_end" }> =>
      event.type === "message_end" && event.message.role === "toolResult",
  )?.message;
}

describe("agentLoop EventStream failures", () => {
  it("ends the public stream when a new prompt run rejects", async () => {
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      undefined,
      failingStreamFn,
    );

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("ends the public stream when a continue run rejects", async () => {
    const context: AgentContext = {
      systemPrompt: "",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
    };
    const stream = agentLoopContinue(context, config, undefined, failingStreamFn);

    const events = await collectEvents(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
  });

  it("keeps rejection failure messages reachable with hostile model identity", async () => {
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      { ...config, model: makeHostileModel() },
      undefined,
      failingStreamFn,
    );

    const events = await collectEventsWithTimeout(stream);
    const result = await stream.result();

    expectTerminalFailure(events, result);
    expect(result[0]).toMatchObject({
      api: "unknown",
      provider: "unknown",
      model: "unknown",
    });
  });
});

describe("agentLoop tool snapshots", () => {
  it("sanitizes prompt-run context tools before provider exposure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const healthySchema = Type.Object({ query: Type.String() });
    const healthy = createTool("healthy_lookup", healthySchema);
    const unreadable = createTool("bad_lookup");
    Object.defineProperty(unreadable, "name", {
      get() {
        throw new Error("revoked name");
      },
    });
    const contexts: Context[] = [];

    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [unreadable, healthy] },
      config,
      undefined,
      createStreamFn(contexts),
    );
    (healthySchema.properties.query as Record<string, unknown>).type = "number";
    await collectEvents(stream);

    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(contexts[0]?.tools?.[0]?.parameters).toMatchObject({
      properties: { query: { type: "string" } },
    });
    expect(
      Object.getOwnPropertyDescriptor(contexts[0]?.tools?.[0]?.parameters, "~kind"),
    ).toMatchObject({ enumerable: false });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent loop tool "tool[0]": revoked name'),
    );
  });

  it("sanitizes continue-run context tools before provider exposure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badTool = createTool("bad_lookup");
    Object.defineProperty(badTool, "parameters", {
      get() {
        throw new Error("revoked parameters");
      },
    });
    const contexts: Context[] = [];

    const stream = agentLoopContinue(
      {
        systemPrompt: "",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
        tools: [badTool, createTool("healthy_lookup")],
      },
      config,
      undefined,
      createStreamFn(contexts),
    );
    await collectEvents(stream);

    expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["healthy_lookup"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent loop tool "bad_lookup": revoked parameters'),
    );
  });

  it("sanitizes prepareNextTurn replacement context tools", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const badTool = createTool("bad_lookup");
    Object.defineProperty(badTool, "parameters", {
      get() {
        throw new Error("revoked parameters");
      },
    });
    const contexts: Context[] = [];
    let followUpPending = true;
    const stream = agentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      {
        ...config,
        getFollowUpMessages: async () => {
          if (!followUpPending) {
            return [];
          }
          followUpPending = false;
          return [{ role: "user", content: "again", timestamp: 2 }];
        },
        prepareNextTurn: () => ({
          context: {
            systemPrompt: "",
            messages: [],
            tools: [badTool, createTool("next_lookup")],
          },
        }),
      },
      undefined,
      createStreamFn(contexts),
    );
    await collectEvents(stream);

    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.tools?.map((tool) => tool.name)).toEqual(["next_lookup"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped invalid agent loop tool "bad_lookup": revoked parameters'),
    );
  });

  it("keeps tool execution errors reachable when thrown values resist stringification", async () => {
    const poisonTool = createTool("poison_tool");
    poisonTool.execute = async () => {
      throw createPoisonedStringificationError();
    };
    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "hello", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [poisonTool] },
        config,
        undefined,
        createToolCallThenDoneStreamFn(),
      ),
    );

    const toolResult = findToolResult(events);
    const finalAgentEnd = events.find(
      (event): event is Extract<AgentEvent, { type: "agent_end" }> => event.type === "agent_end",
    );

    expect(toolResult).toMatchObject({
      role: "toolResult",
      toolCallId: "call_poison",
      toolName: "poison_tool",
      isError: true,
      content: [{ type: "text", text: "Unknown agent failure" }],
    });
    expect(finalAgentEnd?.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
  });

  it("keeps before-tool-call errors reachable when thrown values resist stringification", async () => {
    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "hello", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [createTool("poison_tool")] },
        {
          ...config,
          beforeToolCall: async () => {
            throw createPoisonedStringificationError();
          },
        },
        undefined,
        createToolCallThenDoneStreamFn(),
      ),
    );

    expect(findToolResult(events)).toMatchObject({
      role: "toolResult",
      toolCallId: "call_poison",
      toolName: "poison_tool",
      isError: true,
      content: [{ type: "text", text: "Unknown agent failure" }],
    });
  });

  it("keeps after-tool-call errors reachable when thrown values resist stringification", async () => {
    const events = await collectEvents(
      agentLoop(
        [{ role: "user", content: "hello", timestamp: 1 }],
        { systemPrompt: "", messages: [], tools: [createTool("poison_tool")] },
        {
          ...config,
          afterToolCall: async () => {
            throw createPoisonedStringificationError();
          },
        },
        undefined,
        createToolCallThenDoneStreamFn(),
      ),
    );

    expect(findToolResult(events)).toMatchObject({
      role: "toolResult",
      toolCallId: "call_poison",
      toolName: "poison_tool",
      isError: true,
      content: [{ type: "text", text: "Unknown agent failure" }],
    });
  });
});
