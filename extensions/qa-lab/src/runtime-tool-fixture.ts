// Qa Lab plugin module implements runtime tool fixture behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { readRuntimeToolCoverageMetadata } from "./runtime-tool-metadata.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type QaRuntimeToolFixtureConfig = {
  toolName?: unknown;
  happyPrompt?: unknown;
  failurePrompt?: unknown;
  promptSnippet?: unknown;
  failurePromptSnippet?: unknown;
  ensureImageGeneration?: unknown;
  allowAsyncHappyPath?: unknown;
  asyncHappyPathProof?: unknown;
  expectedAvailable?: unknown;
  toolCoverage?: unknown;
  knownBroken?: unknown;
  knownHarnessGap?: unknown;
};

type QaRuntimeToolFixtureRequest = {
  allInputText?: string;
  plannedToolName?: string;
  plannedToolArgs?: unknown;
};

type QaRuntimeToolFixtureDeps = {
  createSession: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
    label: string,
    key?: string,
  ) => Promise<string>;
  readEffectiveTools: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "primaryModel" | "alternateModel" | "providerMode">,
    sessionKey: string,
  ) => Promise<Set<string>>;
  runAgentPrompt: (
    env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
    params: {
      sessionKey: string;
      message: string;
      timeoutMs?: number;
    },
  ) => Promise<unknown>;
  fetchJson: (url: string) => Promise<unknown>;
  ensureImageGenerationConfigured: (env: QaSuiteRuntimeEnv) => Promise<unknown>;
};

function readString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isKnownBroken(value: unknown) {
  return isRecord(value);
}

function isKnownHarnessGap(value: unknown) {
  return isRecord(value);
}

function isQaRuntimeToolFixtureRequest(value: unknown): value is QaRuntimeToolFixtureRequest {
  return isRecord(value);
}

function readQaRuntimeToolFixtureRequests(value: unknown): QaRuntimeToolFixtureRequest[] {
  return Array.isArray(value) ? value.filter(isQaRuntimeToolFixtureRequest) : [];
}

function readRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function countRecordKeys(records: readonly Record<string, unknown>[]) {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = JSON.stringify(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function findNewImageGenerationRequest(params: {
  before: readonly Record<string, unknown>[];
  after: readonly Record<string, unknown>[];
  prompt: string;
}) {
  const beforeCounts = countRecordKeys(params.before);
  const seenAfter = new Map<string, number>();
  return params.after.find((record) => {
    if (readString(record.prompt) !== params.prompt) {
      return false;
    }
    const key = JSON.stringify(record);
    const seen = (seenAfter.get(key) ?? 0) + 1;
    seenAfter.set(key, seen);
    return seen > (beforeCounts.get(key) ?? 0);
  });
}

function readPlannedPrompt(value: unknown) {
  return isRecord(value) ? readString(value.prompt) : "";
}

function requestMatchesPrompt(request: QaRuntimeToolFixtureRequest, promptSnippet: string) {
  return (request.allInputText ?? "").includes(promptSnippet);
}

function findPlannedRequestEntry(params: {
  requests: readonly QaRuntimeToolFixtureRequest[];
  requestCountBefore: number;
  promptSnippet: string;
  excludedPromptSnippet?: string;
  toolName: string;
}) {
  const foundIndex = params.requests.slice(params.requestCountBefore).findIndex(
    (request) =>
      requestMatchesPrompt(request, params.promptSnippet) &&
      (!params.excludedPromptSnippet ||
        !requestMatchesPrompt(request, params.excludedPromptSnippet)) &&
      request.plannedToolName === params.toolName,
  );
  if (foundIndex < 0) {
    return undefined;
  }
  const index = params.requestCountBefore + foundIndex;
  const request = params.requests[index];
  return request ? { index, request } : undefined;
}

function findPlannedRequest(params: Parameters<typeof findPlannedRequestEntry>[0]) {
  return findPlannedRequestEntry(params)?.request;
}

function formatKnownBrokenDetails(
  toolName: string,
  tools: Set<string>,
  config: QaRuntimeToolFixtureConfig,
) {
  const knownBroken = isKnownBroken(config.knownBroken)
    ? (config.knownBroken as Record<string, unknown>)
    : {};
  const issue = readString(knownBroken.issue);
  const reason = readString(knownBroken.reason, "known broken runtime tool fixture");
  return [
    `known-broken ${toolName}: ${reason}`,
    issue ? `tracking: ${issue}` : undefined,
    `available tools: ${[...tools].toSorted().join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatExpectedUnavailableDetails(toolName: string, tools: Set<string>) {
  return [
    `expected-unavailable ${toolName}: this fixture is report-only for the current profile`,
    `available tools: ${[...tools].toSorted().join(", ")}`,
  ].join("\n");
}

function formatCodexNativeWorkspaceDetails(params: {
  toolName: string;
  tools: Set<string>;
  reason?: string;
  happyRequest?: QaRuntimeToolFixtureRequest;
  failureRequest?: QaRuntimeToolFixtureRequest;
}) {
  return [
    `codex-native-workspace ${params.toolName}: OpenClaw dynamic exposure is intentionally omitted because Codex owns this workspace operation natively`,
    params.reason ? `reason: ${params.reason}` : undefined,
    `available OpenClaw dynamic tools: ${[...params.tools].toSorted().join(", ")}`,
    params.happyRequest
      ? `${params.toolName} mock provider happy planned args (diagnostic only): ${JSON.stringify(params.happyRequest.plannedToolArgs ?? {})}`
      : undefined,
    params.failureRequest
      ? `${params.toolName} mock provider failure planned args (diagnostic only): ${JSON.stringify(params.failureRequest.plannedToolArgs ?? {})}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatKnownHarnessGapDetails(toolName: string, config: QaRuntimeToolFixtureConfig) {
  const knownHarnessGap = isKnownHarnessGap(config.knownHarnessGap)
    ? (config.knownHarnessGap as Record<string, unknown>)
    : {};
  const issue = readString(knownHarnessGap.issue);
  const reason = readString(knownHarnessGap.reason, "known QA harness gap");
  return [`known-harness-gap ${toolName}: ${reason}`, issue ? `tracking: ${issue}` : undefined]
    .filter(Boolean)
    .join("\n");
}

function formatPromptError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForAsyncImageGenerationRequest(params: {
  deps: QaRuntimeToolFixtureDeps;
  mockBaseUrl: string;
  before: readonly Record<string, unknown>[];
  prompt: string;
}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const after = readRecords(await params.deps.fetchJson(`${params.mockBaseUrl}/debug/image-generations`));
    const request = findNewImageGenerationRequest({
      before: params.before,
      after,
      prompt: params.prompt,
    });
    if (request) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

export async function runRuntimeToolFixture(
  env: QaSuiteRuntimeEnv,
  config: QaRuntimeToolFixtureConfig,
  deps: QaRuntimeToolFixtureDeps,
) {
  const toolName = readString(config.toolName);
  if (!toolName) {
    throw new Error("runtime tool fixture missing execution.config.toolName");
  }
  if (config.ensureImageGeneration === true) {
    await deps.ensureImageGenerationConfigured(env);
  }
  await fs.writeFile(
    path.join(env.gateway.workspaceDir, "runtime-tool-fixture-edit.txt"),
    "before edit\n",
    "utf8",
  );

  const happySessionKey = await deps.createSession(
    env,
    `Runtime tool fixture: ${toolName} happy`,
    `agent:qa:runtime-tool:${toolName}:happy`,
  );
  const failureSessionKey = await deps.createSession(
    env,
    `Runtime tool fixture: ${toolName} failure`,
    `agent:qa:runtime-tool:${toolName}:failure`,
  );
  const tools = await deps.readEffectiveTools(env, happySessionKey);
  const metadata = readRuntimeToolCoverageMetadata({
    config: config as Record<string, unknown>,
  });
  const dynamicExposureIntentionallyExcluded =
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME === "codex" &&
    metadata.expectedLayer === "codex-native-workspace";
  const expectedAvailable = readBoolean(config.expectedAvailable, true);
  if (!tools.has(toolName) && !dynamicExposureIntentionallyExcluded) {
    if (!expectedAvailable) {
      return formatExpectedUnavailableDetails(toolName, tools);
    }
    if (isKnownBroken(config.knownBroken)) {
      return formatKnownBrokenDetails(toolName, tools, config);
    }
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(
      `${toolName} not present in effective tools. Available tools: ${[...tools].toSorted().join(", ")}`,
    );
  }

  const happyPrompt = readString(
    config.happyPrompt,
    `tool search qa check target=${toolName}. Call exactly that tool once and then summarize.`,
  );
  const failurePrompt = readString(
    config.failurePrompt,
    `tool search qa failure target=${toolName}. Exercise the denied-input path once and then summarize.`,
  );
  const promptSnippet = readString(config.promptSnippet, `target=${toolName}`);
  const failurePromptSnippet = readString(
    config.failurePromptSnippet,
    `failure target=${toolName}`,
  );
  const requestCountBefore = env.mock
    ? readQaRuntimeToolFixtureRequests(await deps.fetchJson(`${env.mock.baseUrl}/debug/requests`))
        .length
    : 0;
  const allowAsyncHappyPath = readBoolean(config.allowAsyncHappyPath, false);
  const asyncHappyPathProof = readString(config.asyncHappyPathProof);
  const imageGenerationRequestsBefore =
    env.mock && asyncHappyPathProof === "image-generation-request"
      ? readRecords(await deps.fetchJson(`${env.mock.baseUrl}/debug/image-generations`))
      : [];
  let asyncHappyPathError: Error | undefined;
  let asyncHappyPathDetails: string | undefined;
  let asyncHappyPathRequest: QaRuntimeToolFixtureRequest | undefined;

  try {
    await deps.runAgentPrompt(env, {
      sessionKey: happySessionKey,
      message: happyPrompt,
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    });
  } catch (error) {
    const promptError = toError(error);
    if (!allowAsyncHappyPath || !env.mock) {
      throw promptError;
    }
    asyncHappyPathError = promptError;
  }
  if (asyncHappyPathError && env.mock) {
    const requestsAfterHappy = readQaRuntimeToolFixtureRequests(
      await deps.fetchJson(`${env.mock.baseUrl}/debug/requests`),
    );
    const happyEntry = findPlannedRequestEntry({
      requests: requestsAfterHappy,
      requestCountBefore,
      promptSnippet,
      excludedPromptSnippet: failurePromptSnippet,
      toolName,
    });
    if (!happyEntry) {
      throw asyncHappyPathError;
    }
    if (asyncHappyPathProof !== "image-generation-request") {
      throw new Error(
        `allowAsyncHappyPath for ${toolName} requires asyncHappyPathProof: image-generation-request`,
      );
    }
    const happyPlannedPrompt = readPlannedPrompt(happyEntry.request.plannedToolArgs);
    if (!happyPlannedPrompt) {
      throw new Error(`expected happy-path ${toolName} planned args to include prompt`);
    }
    const imageGenerationRequest = await waitForAsyncImageGenerationRequest({
      deps,
      mockBaseUrl: env.mock.baseUrl,
      before: imageGenerationRequestsBefore,
      prompt: happyPlannedPrompt,
    });
    if (!imageGenerationRequest) {
      throw new Error(
        `expected image generation request for happy-path ${toolName}; happy prompt error: ${formatPromptError(asyncHappyPathError)}`,
      );
    }
    asyncHappyPathRequest = happyEntry.request;
    asyncHappyPathDetails = `${toolName} happy path started async image generation before ending: ${formatPromptError(asyncHappyPathError)}`;
  }
  await deps.runAgentPrompt(env, {
    sessionKey: failureSessionKey,
    message: failurePrompt,
    timeoutMs: liveTurnTimeoutMs(env, 45_000),
  });

  if (!env.mock) {
    return `${toolName} fixture completed in live provider mode`;
  }

  const requests = readQaRuntimeToolFixtureRequests(
    await deps.fetchJson(`${env.mock.baseUrl}/debug/requests`),
  );
  const happyRequest =
    asyncHappyPathRequest ??
    findPlannedRequest({
      requests,
      requestCountBefore,
      promptSnippet,
      excludedPromptSnippet: failurePromptSnippet,
      toolName,
    });
  if (!happyRequest) {
    if (dynamicExposureIntentionallyExcluded) {
      return formatCodexNativeWorkspaceDetails({
        toolName,
        tools,
        reason: metadata.reason,
      });
    }
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    if (asyncHappyPathError) {
      throw asyncHappyPathError;
    }
    throw new Error(`expected mock happy-path request for ${toolName}`);
  }
  const failureRequest = findPlannedRequest({
    requests,
    requestCountBefore,
    promptSnippet: failurePromptSnippet,
    toolName,
  });
  if (!failureRequest) {
    if (dynamicExposureIntentionallyExcluded) {
      return formatCodexNativeWorkspaceDetails({
        toolName,
        tools,
        reason: metadata.reason,
        happyRequest,
      });
    }
    if (isKnownHarnessGap(config.knownHarnessGap)) {
      return formatKnownHarnessGapDetails(toolName, config);
    }
    throw new Error(`expected mock failure-path request for ${toolName}`);
  }

  if (dynamicExposureIntentionallyExcluded) {
    return formatCodexNativeWorkspaceDetails({
      toolName,
      tools,
      reason: metadata.reason,
      happyRequest,
      failureRequest,
    });
  }

  return [
    asyncHappyPathDetails,
    `${toolName} mock provider happy planned args (diagnostic only): ${JSON.stringify(happyRequest.plannedToolArgs ?? {})}`,
    `${toolName} mock provider failure planned args (diagnostic only): ${JSON.stringify(failureRequest.plannedToolArgs ?? {})}`,
  ]
    .filter(Boolean)
    .join("\n");
}
