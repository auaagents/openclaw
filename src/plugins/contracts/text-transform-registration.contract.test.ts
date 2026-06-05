// Text transform registration tests cover plugin-owned replacement snapshotting.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { applyPluginTextReplacements } from "../../agents/plugin-text-transforms.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";
import { resolveRuntimeTextTransforms } from "../text-transforms.runtime.js";
import type { PluginTextReplacement, PluginTextTransformRegistration } from "../types.js";

describe("plugin text transform registration", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("snapshots replacement fields before runtime transform resolution", () => {
    let inputReads = 0;
    let outputReads = 0;
    let inputFromReads = 0;
    let inputToReads = 0;
    let outputFromReads = 0;
    let outputToReads = 0;
    const inputReplacement = {
      get from() {
        inputFromReads += 1;
        if (inputFromReads > 1) {
          throw new Error("input from getter re-read");
        }
        return "red";
      },
      get to() {
        inputToReads += 1;
        if (inputToReads > 1) {
          throw new Error("input to getter re-read");
        }
        return "blue";
      },
    } as PluginTextReplacement;
    const outputReplacement = {
      get from() {
        outputFromReads += 1;
        if (outputFromReads > 1) {
          throw new Error("output from getter re-read");
        }
        return /done/u;
      },
      get to() {
        outputToReads += 1;
        if (outputToReads > 1) {
          throw new Error("output to getter re-read");
        }
        return "finished";
      },
    } as PluginTextReplacement;
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "volatile-text-transform",
        name: "Volatile Text Transform",
      }),
      register(api) {
        api.registerTextTransforms({
          get input() {
            inputReads += 1;
            if (inputReads > 1) {
              throw new Error("text transform input getter re-read");
            }
            return [inputReplacement];
          },
          get output() {
            outputReads += 1;
            if (outputReads > 1) {
              throw new Error("text transform output getter re-read");
            }
            return [outputReplacement];
          },
        } as PluginTextTransformRegistration);
      },
    });
    setActivePluginRegistry(registry.registry);

    const transforms = resolveRuntimeTextTransforms();
    expect(applyPluginTextReplacements("red prompt", transforms?.input)).toBe("blue prompt");
    expect(applyPluginTextReplacements("all done", transforms?.output)).toBe("all finished");
    expect(inputReads).toBe(1);
    expect(outputReads).toBe(1);
    expect(inputFromReads).toBe(1);
    expect(inputToReads).toBe(1);
    expect(outputFromReads).toBe(1);
    expect(outputToReads).toBe(1);
  });
});
