// Resolves session-level Local Assist and local MoE policy for model orchestration.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { LocalOrchestrationConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelKey } from "../shared/model-key.js";

const DEFAULT_LOCAL_AGENT_ID = "aua-local";
const DEFAULT_LOCAL_CODE_ALIAS = "local-code";
const DEFAULT_LOCAL_CHAT_ALIAS = "local-chat";
const LOCAL_PROVIDER_IDS = new Set(["ollama"]);

type SessionLocalOrchestrationEntry = Pick<SessionEntry, "localAssist" | "localMoe"> | undefined;

export type ResolvedLocalOrchestrationPolicy = {
  isLocalModel: boolean;
  localAssistEnabled: boolean;
  localMoeEnabled: boolean;
  localAssistDefault: boolean;
  localMoeDefault: boolean;
  localAssistTargetAgent: string;
  localAssistTargetModel: string;
  localMoeCompanionAgent: string;
  localMoeCompanionModel: string;
};

function normalizeModelRefKey(provider: string, model: string): string {
  return normalizeLowercaseStringOrEmpty(modelKey(normalizeProviderId(provider), model));
}

function normalizeConfiguredModelKey(key: string): string {
  const trimmed = key.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  return normalizeLowercaseStringOrEmpty(
    modelKey(normalizeProviderId(trimmed.slice(0, slash)), trimmed.slice(slash + 1)),
  );
}

function mergeLocalOrchestrationConfig(
  base: LocalOrchestrationConfig | undefined,
  override: LocalOrchestrationConfig | undefined,
): LocalOrchestrationConfig | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  return {
    ...(base.localAssist || override.localAssist
      ? { localAssist: { ...base.localAssist, ...override.localAssist } }
      : {}),
    ...(base.moe || override.moe ? { moe: { ...base.moe, ...override.moe } } : {}),
  };
}

function resolveAgentModelMap(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): Record<string, AgentModelEntryConfig> | undefined {
  const normalizedAgentId = normalizeLowercaseStringOrEmpty(agentId);
  if (!normalizedAgentId) {
    return undefined;
  }
  return cfg.agents?.list?.find(
    (entry) => normalizeLowercaseStringOrEmpty(entry?.id) === normalizedAgentId,
  )?.models;
}

function collectModelMapLocalOrchestration(params: {
  models: Record<string, AgentModelEntryConfig> | undefined;
  provider: string;
  model: string;
}): LocalOrchestrationConfig | undefined {
  const selectedKey = normalizeModelRefKey(params.provider, params.model);
  const wildcardKey = normalizeLowercaseStringOrEmpty(`${normalizeProviderId(params.provider)}/*`);
  const modelOnlyKey = normalizeLowercaseStringOrEmpty(params.model);
  let resolved: LocalOrchestrationConfig | undefined;
  for (const [key, entry] of Object.entries(params.models ?? {})) {
    const normalizedKey = normalizeConfiguredModelKey(key);
    if (
      normalizedKey === wildcardKey ||
      normalizedKey === selectedKey ||
      normalizedKey === modelOnlyKey
    ) {
      resolved = mergeLocalOrchestrationConfig(resolved, entry.localOrchestration);
    }
  }
  return resolved;
}

function collectProviderLocalOrchestration(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): LocalOrchestrationConfig | undefined {
  const providerConfig = params.cfg.models?.providers?.[normalizeProviderId(params.provider)];
  let resolved = providerConfig?.localOrchestration;
  const modelEntry = providerConfig?.models?.find(
    (entry) =>
      normalizeLowercaseStringOrEmpty(entry.id) === normalizeLowercaseStringOrEmpty(params.model),
  );
  resolved = mergeLocalOrchestrationConfig(resolved, modelEntry?.localOrchestration);
  return resolved;
}

function resolveConfiguredLocalOrchestration(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  provider: string;
  model: string;
}): LocalOrchestrationConfig | undefined {
  const agentModels = resolveAgentModelMap(params.cfg, params.agentId);
  let resolved = collectProviderLocalOrchestration(params);
  resolved = mergeLocalOrchestrationConfig(
    resolved,
    collectModelMapLocalOrchestration({
      models: params.cfg.agents?.defaults?.models,
      provider: params.provider,
      model: params.model,
    }),
  );
  resolved = mergeLocalOrchestrationConfig(
    resolved,
    collectModelMapLocalOrchestration({
      models: agentModels,
      provider: params.provider,
      model: params.model,
    }),
  );
  return resolved;
}

function resolveModelRefByAlias(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  alias: string;
}): string | undefined {
  const alias = normalizeLowercaseStringOrEmpty(params.alias);
  if (!alias) {
    return undefined;
  }
  const candidates = [
    resolveAgentModelMap(params.cfg, params.agentId),
    params.cfg.agents?.defaults?.models,
  ];
  for (const models of candidates) {
    for (const [key, entry] of Object.entries(models ?? {})) {
      if (normalizeLowercaseStringOrEmpty(entry.alias ?? "") === alias) {
        return key;
      }
    }
  }
  return undefined;
}

function resolveSiblingLocalModel(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  provider: string;
  model: string;
}): string {
  const selectedKey = normalizeModelRefKey(params.provider, params.model);
  const localCode = resolveModelRefByAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    alias: DEFAULT_LOCAL_CODE_ALIAS,
  });
  const localChat = resolveModelRefByAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    alias: DEFAULT_LOCAL_CHAT_ALIAS,
  });
  if (localCode && normalizeConfiguredModelKey(localCode) === selectedKey) {
    return localChat ?? DEFAULT_LOCAL_CHAT_ALIAS;
  }
  if (localChat && normalizeConfiguredModelKey(localChat) === selectedKey) {
    return localCode ?? DEFAULT_LOCAL_CODE_ALIAS;
  }
  return localChat ?? DEFAULT_LOCAL_CHAT_ALIAS;
}

export function isLocalModelProvider(provider: string | null | undefined): boolean {
  const normalized = provider ? normalizeProviderId(provider) : "";
  return Boolean(normalized && LOCAL_PROVIDER_IDS.has(normalized));
}

export function resolveLocalOrchestrationPolicy(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  provider: string;
  model: string;
  sessionEntry?: SessionLocalOrchestrationEntry;
}): ResolvedLocalOrchestrationPolicy {
  const config = resolveConfiguredLocalOrchestration(params);
  const isLocalModel = isLocalModelProvider(params.provider);
  const localAssistDefault = config?.localAssist?.default === true;
  const localMoeDefault = config?.moe?.default === true;
  const configuredLocalAssistTargetModel = normalizeOptionalString(
    config?.localAssist?.targetModel,
  );
  const configuredLocalMoeCompanionModel = normalizeOptionalString(config?.moe?.companionModel);
  return {
    isLocalModel,
    localAssistDefault,
    localMoeDefault,
    localAssistEnabled:
      params.sessionEntry?.localAssist !== undefined
        ? params.sessionEntry.localAssist === true
        : localAssistDefault,
    localMoeEnabled:
      params.sessionEntry?.localMoe !== undefined
        ? params.sessionEntry.localMoe === true
        : localMoeDefault,
    localAssistTargetAgent:
      normalizeOptionalString(config?.localAssist?.targetAgent) ?? DEFAULT_LOCAL_AGENT_ID,
    localAssistTargetModel: configuredLocalAssistTargetModel ?? DEFAULT_LOCAL_CODE_ALIAS,
    localMoeCompanionAgent:
      normalizeOptionalString(config?.moe?.companionAgent) ?? DEFAULT_LOCAL_AGENT_ID,
    localMoeCompanionModel:
      configuredLocalMoeCompanionModel ??
      resolveSiblingLocalModel({
        cfg: params.cfg,
        agentId: params.agentId,
        provider: params.provider,
        model: params.model,
      }),
  };
}

export function buildLocalOrchestrationPrompt(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  provider: string;
  model: string;
  sessionEntry?: SessionLocalOrchestrationEntry;
}): string | undefined {
  const policy = resolveLocalOrchestrationPolicy(params);
  const selectedModel = modelKey(params.provider, params.model);
  if (policy.isLocalModel) {
    if (!policy.localMoeEnabled) {
      return undefined;
    }
    return [
      "[Local MoE]",
      `MoE is enabled for this local session. The visible selected model (${selectedModel}) remains the primary lane.`,
      `You may use ${policy.localMoeCompanionAgent} with model ${policy.localMoeCompanionModel} as a temporary local specialist when it improves the answer.`,
      "Before using the specialist, briefly judge whether the extra pass is worth the latency. Skip it for simple replies.",
      "Use the specialist for planning, critique, synthesis, explanation, or checking a sub-result. Keep tool/file-changing work owned by the primary coding lane unless the user asks otherwise.",
      "Return one coherent answer in this same session. Do not expose internal routing details unless they are useful to Rog.",
    ].join("\n");
  }
  if (!policy.localAssistEnabled) {
    return undefined;
  }
  return [
    "[Local Assist]",
    `Local Assist is enabled for this non-local session. The visible selected model (${selectedModel}) remains the primary lane.`,
    `When local compute can handle a substep well, you may delegate it to ${policy.localAssistTargetAgent} with model ${policy.localAssistTargetModel}.`,
    "Prefer local assistance for long-running diagnostics, repo/config inspection, drafts, summaries, and quota-saving exploratory work.",
    "Score expected value before delegating. Do not add a local hop for trivial turns, and keep the final response coherent in this session.",
  ].join("\n");
}
