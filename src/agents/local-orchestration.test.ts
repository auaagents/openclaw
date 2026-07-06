import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildLocalOrchestrationPrompt,
  resolveLocalOrchestrationPolicy,
} from "./local-orchestration.js";

const baseConfig = {
  agents: {
    defaults: {
      models: {
        "ollama/gemma4-opencode:26b-262k": { alias: "local-code" },
        "ollama/gemma4:26b-a4b-it-qat": { alias: "local-chat" },
      },
    },
    list: [
      {
        id: "aua-local",
        models: {
          "ollama/gemma4-opencode:26b-262k": { alias: "local-code" },
          "ollama/gemma4:26b-a4b-it-qat": { alias: "local-chat" },
        },
      },
    ],
  },
} satisfies OpenClawConfig;

describe("local orchestration policy", () => {
  test("builds a local MoE prompt with the sibling local model", () => {
    const prompt = buildLocalOrchestrationPrompt({
      cfg: baseConfig,
      agentId: "aua-local",
      provider: "ollama",
      model: "gemma4-opencode:26b-262k",
      sessionEntry: { localMoe: true } as SessionEntry,
    });

    expect(prompt).toContain("[Local MoE]");
    expect(prompt).toContain("ollama/gemma4-opencode:26b-262k");
    expect(prompt).toContain("ollama/gemma4:26b-a4b-it-qat");
  });

  test("builds a Local Assist prompt for non-local models", () => {
    const prompt = buildLocalOrchestrationPrompt({
      cfg: baseConfig,
      agentId: "main",
      provider: "anthropic",
      model: "claude-fable-5",
      sessionEntry: { localAssist: true } as SessionEntry,
    });

    expect(prompt).toContain("[Local Assist]");
    expect(prompt).toContain("anthropic/claude-fable-5");
    expect(prompt).toContain("aua-local");
    expect(prompt).toContain("local-code");
  });

  test("uses configured MoE defaults and lets sessions disable them", () => {
    const cfg = {
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        list: [
          {
            id: "aua-local",
            models: {
              "ollama/gemma4-opencode:26b-262k": {
                alias: "local-code",
                localOrchestration: {
                  moe: {
                    default: true,
                    companionModel: "local-chat",
                  },
                },
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(
      resolveLocalOrchestrationPolicy({
        cfg,
        agentId: "aua-local",
        provider: "ollama",
        model: "gemma4-opencode:26b-262k",
      }).localMoeEnabled,
    ).toBe(true);
    expect(
      resolveLocalOrchestrationPolicy({
        cfg,
        agentId: "aua-local",
        provider: "ollama",
        model: "gemma4-opencode:26b-262k",
        sessionEntry: { localMoe: false } as SessionEntry,
      }).localMoeEnabled,
    ).toBe(false);
  });
});
