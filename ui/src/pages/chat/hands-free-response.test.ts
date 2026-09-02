// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  findLatestHandsFreeAssistantResponse,
  HandsFreeResponseSpeaker,
  summarizeHandsFreeResponse,
} from "./hands-free-response.ts";

class FakeAudio {
  static instances: FakeAudio[] = [];
  private listeners = new Map<string, Set<() => void>>();
  src = "";
  pause = vi.fn();
  play = vi.fn(async () => {
    queueMicrotask(() => this.emit("ended"));
  });

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

beforeEach(() => {
  FakeAudio.instances = [];
  vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("hands-free response readback", () => {
  it("reads only the explicit voice handoff, never a heuristic final-answer digest", () => {
    expect(
      summarizeHandsFreeResponse(
        "Voice handoff: The gateway is healthy and serving the update. Next, reload the Control UI.\n\n# Finished\n\n```ts\nsecret details\n```",
      ),
    ).toBe("The gateway is healthy and serving the update. Next, reload the Control UI.");
  });

  it("uses a truthful fixed fallback when the final answer misses the voice contract", () => {
    expect(summarizeHandsFreeResponse("# Finished\n\nThe gateway is healthy.")).toBe(
      "Response complete. The detailed response is available in chat.",
    );
  });

  it("reads only the latest final assistant phase, not commentary or tool chatter", () => {
    const response = findLatestHandsFreeAssistantResponse([
      {
        role: "assistant",
        __openclaw: { id: "commentary" },
        content: [
          {
            type: "text",
            text: "I am still considering the tool output.",
            textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
          },
        ],
      },
      {
        role: "assistant",
        __openclaw: { id: "final" },
        content: [
          {
            type: "output_text",
            text: "The migration completed and the gateway is healthy.",
            textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          },
          { type: "tool_result", text: "never spoken" },
        ],
      },
    ]);

    expect(response).toEqual({
      key: "final",
      text: "The migration completed and the gateway is healthy.",
    });
  });

  it("requests Jenny from the bundled Microsoft provider and plays one clip", async () => {
    const request = vi.fn(async () => ({
      audioBase64: "AQID",
      mimeType: "audio/mpeg",
    }));
    const speaker = new HandsFreeResponseSpeaker({ request } as unknown as GatewayBrowserClient);

    await speaker.speak("Voice handoff: The update is ready for review.");

    expect(request).toHaveBeenCalledWith("tts.speak", {
      text: "The update is ready for review.",
      provider: "microsoft",
      voiceId: "en-US-JennyNeural",
    });
    expect(FakeAudio.instances).toHaveLength(1);
    expect(FakeAudio.instances[0]?.src).toBe("data:audio/mpeg;base64,AQID");
  });
});
