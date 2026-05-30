// Private helper surface for the bundled Codex plugin. This is intentionally
// local-only so Codex can mirror app-server native subagents into OpenClaw's
// task registry without promoting detached task mutation helpers to the public
// plugin SDK.

import {
  isInternalAnnounceRequesterSession,
  loadRequesterSessionEntry,
} from "../agents/subagent-announce-delivery.js";
import { resolveAnnounceOrigin } from "../agents/subagent-announce-origin.js";
import {
  SUBAGENT_ENDED_OUTCOME_ERROR,
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_OUTCOME_OK,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  SUBAGENT_TARGET_KIND_SUBAGENT,
  type SubagentLifecycleEndedOutcome,
  type SubagentLifecycleEndedReason,
} from "../agents/subagent-lifecycle-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  assertAgentHarnessTaskRuntimeScope,
  type AgentHarnessTaskRuntimeScope,
} from "../tasks/agent-harness-task-runtime-scope.js";

export {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_RUNTIME,
  CODEX_NATIVE_SUBAGENT_STALE_ERROR,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "../tasks/codex-native-subagent-task.js";

export {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
} from "../tasks/detached-task-runtime.js";

export type { AgentHarnessTaskRuntimeScope };
export type { SubagentLifecycleEndedOutcome, SubagentLifecycleEndedReason };

const log = createSubsystemLogger("plugin-sdk/codex-native-task-runtime");

export async function emitAgentHarnessSubagentSpawnedHook(params: {
  scope: AgentHarnessTaskRuntimeScope;
  runId: string;
  childSessionKey: string;
  agentId?: string;
  label?: string;
  mode: "run" | "session";
  threadRequested: boolean;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_spawned")) {
    return;
  }
  try {
    const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
    const requesterOrigin = resolveAgentHarnessRequesterOrigin(scope);
    await hookRunner.runSubagentSpawned(
      {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
        agentId: params.agentId?.trim() || "unknown",
        label: normalizeOptionalString(params.label),
        requester: {
          channel: requesterOrigin?.channel,
          accountId: requesterOrigin?.accountId,
          to: requesterOrigin?.to,
          threadId: requesterOrigin?.threadId,
        },
        threadRequested: params.threadRequested,
        mode: params.mode,
      },
      {
        runId: params.runId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: scope.requesterSessionKey,
      },
    );
  } catch (error) {
    log.warn("failed to emit Codex native subagent_spawned hook", {
      runId: params.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function emitAgentHarnessSubagentEndedHook(params: {
  scope: AgentHarnessTaskRuntimeScope;
  runId: string;
  targetSessionKey: string;
  reason: SubagentLifecycleEndedReason;
  outcome: SubagentLifecycleEndedOutcome;
  endedAt?: number;
  error?: string;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_ended")) {
    return;
  }
  try {
    const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
    const requesterOrigin = resolveAgentHarnessRequesterOrigin(scope);
    await hookRunner.runSubagentEnded(
      {
        targetSessionKey: params.targetSessionKey,
        targetKind: SUBAGENT_TARGET_KIND_SUBAGENT,
        reason: params.reason,
        accountId: requesterOrigin?.accountId,
        runId: params.runId,
        endedAt: params.endedAt,
        outcome: params.outcome,
        error: params.error,
      },
      {
        runId: params.runId,
        childSessionKey: params.targetSessionKey,
        requesterSessionKey: scope.requesterSessionKey,
      },
    );
  } catch (error) {
    log.warn("failed to emit Codex native subagent_ended hook", {
      runId: params.runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resolveAgentHarnessSucceededSubagentEnd(): {
  reason: SubagentLifecycleEndedReason;
  outcome: SubagentLifecycleEndedOutcome;
} {
  return {
    reason: SUBAGENT_ENDED_REASON_COMPLETE,
    outcome: SUBAGENT_ENDED_OUTCOME_OK,
  };
}

export function resolveAgentHarnessFailedSubagentEnd(): {
  reason: SubagentLifecycleEndedReason;
  outcome: SubagentLifecycleEndedOutcome;
} {
  return {
    reason: SUBAGENT_ENDED_REASON_ERROR,
    outcome: SUBAGENT_ENDED_OUTCOME_ERROR,
  };
}

export function resolveAgentHarnessKilledSubagentEnd(): {
  reason: SubagentLifecycleEndedReason;
  outcome: SubagentLifecycleEndedOutcome;
} {
  return {
    reason: SUBAGENT_ENDED_REASON_KILLED,
    outcome: SUBAGENT_ENDED_OUTCOME_KILLED,
  };
}

function resolveAgentHarnessRequesterOrigin(scope: AgentHarnessTaskRuntimeScope) {
  if (isInternalAnnounceRequesterSession(scope.requesterSessionKey)) {
    return scope.requesterOrigin;
  }
  const { entry } = loadRequesterSessionEntry(scope.requesterSessionKey);
  return resolveAnnounceOrigin(entry, scope.requesterOrigin);
}
