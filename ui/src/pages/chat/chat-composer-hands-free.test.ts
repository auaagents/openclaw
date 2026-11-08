// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type {
  BrowserSpeechRecognition,
  BrowserSpeechRecognitionResultEvent,
} from "./browser-dictation.ts";
import {
  createComposerContainer,
  createComposerProps,
  findComposerButton,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer-render.test-support.ts";

class FakeSpeechRecognition implements BrowserSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  continuous = false;
  interimResults = false;
  lang = "";
  start = vi.fn();
  stop = vi.fn();

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  addEventListener(type: "result" | "error" | "end", listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emitResult(event: BrowserSpeechRecognitionResultEvent): void {
    for (const listener of this.listeners.get("result") ?? []) {
      listener(event);
    }
  }
}

class FakeAudio {
  private listeners = new Map<string, Set<() => void>>();
  src = "";
  pause = vi.fn();
  play = vi.fn(async () => {
    queueMicrotask(() => {
      for (const listener of this.listeners.get("ended") ?? []) {
        listener();
      }
    });
  });

  constructor(src: string) {
    this.src = src;
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
}

function dictationPointer(): PointerEvent {
  return Object.assign(
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    {
      pointerId: 15,
    },
  ) as PointerEvent;
}

afterEach(async () => {
  await resetComposerFixture();
  FakeSpeechRecognition.instances = [];
});

describe("hands-free browser dictation", () => {
  it("prefers browser dictation and inserts final speech without creating a Talk session", () => {
    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
    const onDraftChange = vi.fn();
    const onToggleRealtimeTalk = vi.fn();
    const container = createComposerContainer();
    document.body.append(container);
    const props = createComposerProps({ onDraftChange, onToggleRealtimeTalk });
    const draw = () => render(renderChatComposer(props), container);
    props.onRequestUpdate = draw;
    draw();

    const microphone = findComposerButton(container, t("chat.composer.startVoiceInput"));
    microphone.dispatchEvent(dictationPointer());
    microphone.click();
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("expected browser dictation recognition");
    }
    expect(recognition.start).toHaveBeenCalledOnce();
    expect(recognition.lang).toBe("en-US");
    expect(container.querySelector(".chat-send-btn--dictating")).not.toBeNull();

    recognition.emitResult({
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: true, 0: { transcript: "hello comma openclaw period" } },
      },
    });

    expect(onDraftChange).toHaveBeenCalledWith("Hello, openclaw.", undefined);
    expect(onToggleRealtimeTalk).not.toHaveBeenCalled();
  });

  it("reads a final response once and resumes browser dictation after a hands-free send", async () => {
    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
    vi.stubGlobal("Audio", FakeAudio);
    const onDraftChange = vi.fn();
    const onSend = vi.fn();
    const request = vi.fn(async () => ({ audioBase64: "AQID", mimeType: "audio/mpeg" }));
    const container = createComposerContainer();
    document.body.append(container);
    const props = createComposerProps({ onDraftChange, onSend });
    const draw = () => render(renderChatComposer(props), container);
    props.onRequestUpdate = draw;
    draw();

    const microphone = findComposerButton(container, t("chat.composer.startVoiceInput"));
    microphone.dispatchEvent(dictationPointer());
    microphone.click();
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("expected browser dictation recognition");
    }

    recognition.emitResult({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal: true, 0: { transcript: "Explain this regression" } } },
    });
    recognition.emitResult({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal: true, 0: { transcript: "send a message" } } },
    });

    expect(onDraftChange).toHaveBeenLastCalledWith("Explain this regression", undefined);
    expect(onSend).toHaveBeenCalledOnce();
    expect(recognition.stop).toHaveBeenCalledOnce();

    props.sending = true;
    draw();
    props.sending = false;
    props.gatewayClient = { request } as unknown as GatewayBrowserClient;
    props.messages = [
      {
        role: "assistant",
        __openclaw: { id: "final" },
        content: [
          {
            type: "output_text",
            text: "Voice handoff: The regression is fixed and ready to verify.",
            textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          },
        ],
      },
    ];
    draw();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("tts.speak", {
        text: "The regression is fixed and ready to verify.",
        provider: "microsoft",
        voiceId: "en-US-JennyNeural",
      }),
    );
    await vi.waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(2));
    expect(request.mock.calls.filter(([method]) => method === "tts.speak")).toHaveLength(1);
  });
});
