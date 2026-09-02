// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrowserDictationController,
  collectBrowserSpeechRecognitionText,
  formatBrowserDictationTranscript,
  splitBrowserDictationSendCommand,
  supportsBrowserDictation,
  type BrowserSpeechRecognition,
  type BrowserSpeechRecognitionResultEvent,
} from "./browser-dictation.ts";

class FakeSpeechRecognition implements BrowserSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: BrowserSpeechRecognitionResultEvent) => void) | null = null;
  onerror: ((event: { error?: string; message?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn();

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }
}

function result(transcript: string, isFinal: boolean) {
  return { isFinal, 0: { transcript } };
}

beforeEach(() => {
  FakeSpeechRecognition.instances = [];
  vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser dictation", () => {
  it("detects browser support, configures continuous English recognition, and formats speech punctuation", () => {
    const onCommit = vi.fn();
    const onStateChange = vi.fn();
    const controller = new BrowserDictationController({
      enabled: true,
      onCommit: (text) => onCommit(formatBrowserDictationTranscript(text)),
      onSend: vi.fn(),
      onError: vi.fn(),
      onStateChange,
    });

    expect(supportsBrowserDictation()).toBe(true);
    expect(controller.startDirect()).toBe(true);
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("expected browser recognition to start");
    }
    expect(recognition.continuous).toBe(true);
    expect(recognition.interimResults).toBe(true);
    expect(recognition.lang).toBe("en-US");

    recognition?.onresult?.({
      resultIndex: 0,
      results: { length: 2, 0: result("hello comma world", true), 1: result("how are", false) },
    });
    expect(onCommit).toHaveBeenCalledWith("Hello, world");
    expect(controller.transcript).toBe("how are");
    expect(onStateChange).toHaveBeenCalled();
  });

  it("restarts after an ordinary browser end but stops permanently when the operator toggles it off", () => {
    vi.useFakeTimers();
    const controller = new BrowserDictationController({
      enabled: true,
      onCommit: vi.fn(),
      onSend: vi.fn(),
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    controller.startDirect();
    const first = FakeSpeechRecognition.instances[0];
    first?.onend?.();
    vi.advanceTimersByTime(250);
    expect(FakeSpeechRecognition.instances).toHaveLength(2);
    expect(controller.active).toBe(true);

    return controller.finishActive().then(() => {
      expect(FakeSpeechRecognition.instances[1]?.stop).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(250);
      expect(FakeSpeechRecognition.instances).toHaveLength(2);
      expect(controller.active).toBe(false);
    });
  });

  it("reports blocked microphone access without scheduling another recognition session", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const controller = new BrowserDictationController({
      enabled: true,
      onCommit: vi.fn(),
      onSend: vi.fn(),
      onError,
      onStateChange: vi.fn(),
    });
    controller.startDirect();
    FakeSpeechRecognition.instances[0]?.onerror?.({ error: "not-allowed" });
    vi.advanceTimersByTime(250);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("permission was blocked"), {
      kind: "interrupted",
      preservesText: false,
    });
    expect(FakeSpeechRecognition.instances).toHaveLength(1);
    expect(controller.active).toBe(false);
  });

  it("separates final and interim browser results", () => {
    expect(
      collectBrowserSpeechRecognitionText({
        resultIndex: 1,
        results: {
          length: 3,
          0: result("ignored", true),
          1: result("final", true),
          2: result("partial", false),
        },
      }),
    ).toEqual({ finalText: "final", interimText: "partial" });
  });

  it("recognizes explicit final send commands without treating ordinary prose as a command", () => {
    expect(splitBrowserDictationSendCommand("Send a message.")).toEqual({
      text: "",
      shouldSend: true,
    });
    expect(splitBrowserDictationSendCommand("Summarize the update. Send prompt")).toEqual({
      text: "Summarize the update.",
      shouldSend: true,
    });
    expect(splitBrowserDictationSendCommand("Please send message details to the team")).toEqual({
      text: "Please send message details to the team",
      shouldSend: false,
    });
  });

  it("commits speech before submitting on a final send command, then stops listening", () => {
    const onCommit = vi.fn();
    const onSend = vi.fn();
    const controller = new BrowserDictationController({
      enabled: true,
      onCommit,
      onSend,
      onError: vi.fn(),
      onStateChange: vi.fn(),
    });
    controller.startDirect();
    const recognition = FakeSpeechRecognition.instances[0];
    if (!recognition) {
      throw new Error("expected browser recognition to start");
    }

    recognition.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: result("Explain the failure period send a prompt", true) },
    });

    expect(onCommit).toHaveBeenCalledWith("Explain the failure period");
    expect(onSend).toHaveBeenCalledOnce();
    expect(recognition.stop).toHaveBeenCalledOnce();
    expect(controller.active).toBe(false);
  });
});
