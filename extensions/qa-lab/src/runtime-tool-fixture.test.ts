// Qa Lab tests cover runtime tool fixture plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runRuntimeToolFixture } from "./runtime-tool-fixture.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const tempRoots: string[] = [];

async function makeEnv(overrides: Partial<QaSuiteRuntimeEnv> = {}): Promise<QaSuiteRuntimeEnv> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-tool-fixture-"));
  tempRoots.push(workspaceDir);
  return {
    repoRoot: workspaceDir,
    providerMode: "mock-openai",
    primaryModel: "openai/gpt-5.5",
    alternateModel: "openai/gpt-5.5",
    mock: null,
    cfg: {},
    transport: {} as QaSuiteRuntimeEnv["transport"],
    gateway: {
      baseUrl: "http://127.0.0.1:1",
      tempRoot: workspaceDir,
      workspaceDir,
      runtimeEnv: {},
      call: vi.fn(),
    },
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true })),
  );
});

describe("runtime tool fixture", () => {
  it("checks effective tools on the same session used for the happy prompt", async () => {
    const env = await makeEnv();
    const createdKeys: string[] = [];
    const promptKeys: string[] = [];
    const readEffectiveTools = vi.fn(async (_env, sessionKey: string) => {
      expect(sessionKey).toBe("agent:qa:runtime-tool:read:happy");
      return new Set(["read"]);
    });

    await runRuntimeToolFixture(
      env,
      {
        toolName: "read",
        toolCoverage: {
          bucket: "openclaw-dynamic-integration",
          expectedLayer: "openclaw-dynamic",
        },
      },
      {
        createSession: vi.fn(async (_env, _label, key) => {
          createdKeys.push(key);
          return key;
        }),
        readEffectiveTools,
        runAgentPrompt: vi.fn(async (_env, params) => {
          promptKeys.push(params.sessionKey);
          return {};
        }),
        fetchJson: vi.fn(),
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(createdKeys).toEqual([
      "agent:qa:runtime-tool:read:happy",
      "agent:qa:runtime-tool:read:failure",
    ]);
    expect(promptKeys).toEqual([
      "agent:qa:runtime-tool:read:happy",
      "agent:qa:runtime-tool:read:failure",
    ]);
  });

  it("does not fail Codex-native fixtures solely because OpenClaw dynamic exposure is absent", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
      gateway: {
        baseUrl: "http://127.0.0.1:1",
        tempRoot: "",
        workspaceDir: "",
        runtimeEnv: { OPENCLAW_QA_FORCE_RUNTIME: "codex" },
        call: vi.fn(),
      },
    });
    env.gateway.tempRoot = env.repoRoot;
    env.gateway.workspaceDir = env.repoRoot;

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
      ]);

    const details = await runRuntimeToolFixture(
      env,
      {
        toolName: "read",
        toolCoverage: {
          bucket: "codex-native-workspace",
          expectedLayer: "codex-native-workspace",
          reason: "Codex owns read natively.",
        },
        promptSnippet: "target=read",
        failurePromptSnippet: "failure target=read",
      },
      {
        createSession: vi.fn(async (_env, _label, key) => key!),
        readEffectiveTools: vi.fn(async () => new Set<string>()),
        runAgentPrompt: vi.fn(async () => ({})),
        fetchJson,
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(details).toContain("codex-native-workspace read");
    expect(details).toContain("OpenClaw dynamic exposure is intentionally omitted");
    expect(details).toContain("mock provider happy planned args (diagnostic only)");
  });

  it("still fails required OpenClaw dynamic fixtures when the tool is absent", async () => {
    const env = await makeEnv();

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "web_search",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt: vi.fn(async () => ({})),
          fetchJson: vi.fn(),
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("web_search not present in effective tools");
  });

  it("accepts async happy-path completion after the matching image request starts", async () => {
    const env = await makeEnv({ mock: { baseUrl: "http://127.0.0.1:9999" } });
    const runAgentPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent.wait returned error: agent run aborted"))
      .mockResolvedValueOnce({});
    const happyRequest = {
      allInputText: "target=image_generate",
      plannedToolName: "image_generate",
      plannedToolArgs: { prompt: "QA lighthouse runtime parity fixture" },
    };
    const failureRequest = {
      allInputText: "failure target=image_generate",
      plannedToolName: "image_generate",
      plannedToolArgs: { prompt: "" },
    };
    let requestReads = 0;
    let imageGenerationReads = 0;
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith("/debug/image-generations")) {
        imageGenerationReads += 1;
        return imageGenerationReads === 1
          ? []
          : [{ prompt: "QA lighthouse runtime parity fixture" }];
      }
      requestReads += 1;
      if (requestReads === 1) {
        return [];
      }
      if (requestReads === 2) {
        return [happyRequest];
      }
      return [happyRequest, failureRequest];
    });

    const details = await runRuntimeToolFixture(
      env,
      {
        toolName: "image_generate",
        allowAsyncHappyPath: true,
        asyncHappyPathProof: "image-generation-request",
        promptSnippet: "target=image_generate",
        failurePromptSnippet: "failure target=image_generate",
        toolCoverage: {
          bucket: "openclaw-dynamic-integration",
          expectedLayer: "openclaw-dynamic",
        },
      },
      {
        createSession: vi.fn(async (_env, _label, key) => key!),
        readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
        runAgentPrompt,
        fetchJson,
        ensureImageGenerationConfigured: vi.fn(),
      },
    );

    expect(runAgentPrompt).toHaveBeenCalledTimes(2);
    expect(details).toContain("happy path started async image generation");
    expect(details).toContain("mock provider happy planned args");
    expect(details).toContain("mock provider failure planned args");
  });

  it("keeps async happy-path failures fatal when only the failure request is recorded", async () => {
    const env = await makeEnv({ mock: { baseUrl: "http://127.0.0.1:9999" } });
    const runAgentPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent.wait returned error: agent run aborted"))
      .mockResolvedValueOnce({});
    const failureRequest = {
      allInputText: "failure target=image_generate",
      plannedToolName: "image_generate",
      plannedToolArgs: { prompt: "" },
    };
    let requestReads = 0;
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith("/debug/image-generations")) {
        return [];
      }
      requestReads += 1;
      return requestReads === 1 ? [] : [failureRequest];
    });

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          allowAsyncHappyPath: true,
          asyncHappyPathProof: "image-generation-request",
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt,
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("agent run aborted");
    expect(runAgentPrompt).toHaveBeenCalledTimes(1);
  });

  it("rejects async happy-path completion without execution proof", async () => {
    const env = await makeEnv({ mock: { baseUrl: "http://127.0.0.1:9999" } });
    const runAgentPrompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent.wait returned error: agent run aborted"))
      .mockResolvedValueOnce({});
    const happyRequest = {
      allInputText: "target=image_generate",
      plannedToolName: "image_generate",
      plannedToolArgs: { prompt: "QA lighthouse runtime parity fixture" },
    };
    const failureRequest = {
      allInputText: "failure target=image_generate",
      plannedToolName: "image_generate",
      plannedToolArgs: { prompt: "" },
    };
    let requestReads = 0;
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith("/debug/image-generations")) {
        return [];
      }
      requestReads += 1;
      if (requestReads === 1) {
        return [];
      }
      return requestReads === 2 ? [happyRequest] : [happyRequest, failureRequest];
    });

    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "image_generate",
          allowAsyncHappyPath: true,
          asyncHappyPathProof: "image-generation-request",
          promptSnippet: "target=image_generate",
          failurePromptSnippet: "failure target=image_generate",
          toolCoverage: {
            bucket: "openclaw-dynamic-integration",
            expectedLayer: "openclaw-dynamic",
          },
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set(["image_generate"])),
          runAgentPrompt,
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toThrow("expected image generation request for happy-path image_generate");
    expect(runAgentPrompt).toHaveBeenCalledTimes(1);
  });
});
