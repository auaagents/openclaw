import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import {
  emitAgentHarnessSubagentEndedHook,
  emitAgentHarnessSubagentSpawnedHook,
} from "./codex-native-task-runtime.js";

vi.mock("../agents/subagent-announce-delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/subagent-announce-delivery.js")>();
  return {
    ...actual,
    isInternalAnnounceRequesterSession: vi.fn(() => true),
  };
});

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

describe("codex-native-task-runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGlobalHookRunner).mockReturnValue(null);
  });

  function createScope(
    requesterSessionKey = "agent:main:channel:C123",
    requesterOrigin?: Parameters<typeof createAgentHarnessTaskRuntimeScope>[0]["requesterOrigin"],
  ) {
    return createAgentHarnessTaskRuntimeScope({ requesterSessionKey, requesterOrigin });
  }

  it("emits subagent_spawned with requester metadata from the harness scope", async () => {
    const runSubagentSpawned = vi.fn(async () => {});
    vi.mocked(getGlobalHookRunner).mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_spawned",
      runSubagentSpawned,
    } as never);
    const scope = createScope("agent:main:discord:channel:C123", {
      channel: "discord",
      accountId: "work",
      to: "channel:C123",
      threadId: "456",
    });

    await emitAgentHarnessSubagentSpawnedHook({
      scope,
      runId: "codex-thread:child-thread",
      childSessionKey: "codex-thread:child-thread",
      agentId: "main",
      label: "research",
      threadRequested: false,
      mode: "run",
    });

    expect(runSubagentSpawned).toHaveBeenCalledWith(
      {
        runId: "codex-thread:child-thread",
        childSessionKey: "codex-thread:child-thread",
        agentId: "main",
        label: "research",
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:C123",
          threadId: "456",
        },
        threadRequested: false,
        mode: "run",
      },
      {
        runId: "codex-thread:child-thread",
        childSessionKey: "codex-thread:child-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
      },
    );
  });

  it("emits subagent_ended with requester account metadata and swallows hook failures", async () => {
    const runSubagentEnded = vi.fn(async () => {
      throw new Error("hook failed");
    });
    vi.mocked(getGlobalHookRunner).mockReturnValue({
      hasHooks: (hookName: string) => hookName === "subagent_ended",
      runSubagentEnded,
    } as never);
    const scope = createScope("agent:main:discord:channel:C123", {
      channel: "discord",
      accountId: "work",
      to: "channel:C123",
    });

    await expect(
      emitAgentHarnessSubagentEndedHook({
        scope,
        runId: "codex-thread:child-thread",
        targetSessionKey: "codex-thread:child-thread",
        reason: "subagent-error",
        outcome: "error",
        endedAt: 1_234,
        error: "boom",
      }),
    ).resolves.toBeUndefined();

    expect(runSubagentEnded).toHaveBeenCalledWith(
      {
        targetSessionKey: "codex-thread:child-thread",
        targetKind: "subagent",
        reason: "subagent-error",
        accountId: "work",
        runId: "codex-thread:child-thread",
        endedAt: 1_234,
        outcome: "error",
        error: "boom",
      },
      {
        runId: "codex-thread:child-thread",
        childSessionKey: "codex-thread:child-thread",
        requesterSessionKey: "agent:main:discord:channel:C123",
      },
    );
  });
});
