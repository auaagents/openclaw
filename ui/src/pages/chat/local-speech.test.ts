// Control UI chat module tests local browser speech helpers.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendDictationText,
  findLatestSpeechMessage,
  formatDictationTranscript,
  isDictationSubmitCommand,
  selectJennyVoice,
  speakWithLocalVoice,
} from "./local-speech.ts";

function voice(name: string, lang: string): SpeechSynthesisVoice {
  return {
    default: false,
    lang,
    localService: true,
    name,
    voiceURI: name,
  } as SpeechSynthesisVoice;
}

const originalSpeechSynthesis = globalThis.speechSynthesis;
const originalSpeechSynthesisUtterance = globalThis.SpeechSynthesisUtterance;

afterEach(() => {
  Object.defineProperty(globalThis, "speechSynthesis", {
    configurable: true,
    value: originalSpeechSynthesis,
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: originalSpeechSynthesisUtterance,
  });
});

describe("local speech dictation formatting", () => {
  it("turns spoken punctuation into readable text", () => {
    expect(
      formatDictationTranscript(
        "hello comma this is local dictation period new line does punctuation work question mark",
      ),
    ).toBe("Hello, this is local dictation.\nDoes punctuation work?");
  });

  it("attaches punctuation chunks to the existing draft", () => {
    expect(appendDictationText("Hello", formatDictationTranscript("period", "Hello"))).toBe(
      "Hello.",
    );
  });

  it("adds a separating space for normal dictated chunks", () => {
    expect(appendDictationText("Hello", formatDictationTranscript("there", "Hello"))).toBe(
      "Hello there",
    );
  });

  it("recognizes strict spoken submit commands", () => {
    expect(isDictationSubmitCommand("send message")).toBe(true);
    expect(isDictationSubmitCommand("Send a message.")).toBe(true);
    expect(isDictationSubmitCommand("submit the prompt")).toBe(true);
    expect(isDictationSubmitCommand("send message to Bob")).toBe(false);
  });
});

describe("local speech message selection", () => {
  it("selects the latest readable assistant message", () => {
    const message = findLatestSpeechMessage(
      "main",
      [
        { role: "assistant", content: "old", timestamp: 1, messageId: "a" },
        { role: "user", content: "newer user", timestamp: 2, messageId: "u" },
        { role: "assistant", content: [{ type: "text", text: "latest" }], timestamp: 3 },
      ],
      {
        roles: ["assistant"],
      },
    );

    expect(message).toMatchObject({
      role: "assistant",
      text: "latest",
      timestamp: 3,
    });
    expect(message?.id).toMatch(/^main:assistant:3:/);
  });
});

describe("local speech voice selection", () => {
  it("prefers Microsoft Jenny when available", () => {
    expect(
      selectJennyVoice([
        voice("Google US English", "en-US"),
        voice("Microsoft Jenny Online (Natural) - English (United States)", "en-US"),
      ])?.name,
    ).toContain("Jenny");
  });

  it("waits for Jenny before speaking when browser voices load late", () => {
    let voices = [voice("Google US English", "en-US")];
    const voiceEvents: { voicesChanged?: () => void } = {};
    const speak = vi.fn();
    const cancel = vi.fn();

    class FakeSpeechSynthesisUtterance {
      onend: (() => void) | null = null;
      onerror: ((event: { error?: string }) => void) | null = null;
      pitch = 1;
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      constructor(public text: string) {}
      addEventListener() {}
    }

    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      configurable: true,
      value: FakeSpeechSynthesisUtterance,
    });
    Object.defineProperty(globalThis, "speechSynthesis", {
      configurable: true,
      value: {
        addEventListener: (_event: string, callback: EventListenerOrEventListenerObject) => {
          voiceEvents.voicesChanged = callback as () => void;
        },
        cancel,
        getVoices: () => voices,
        removeEventListener: vi.fn(),
        speak,
      },
    });

    speakWithLocalVoice({ text: "hello" });

    expect(speak).not.toHaveBeenCalled();

    voices = [voice("Microsoft Jenny Online (Natural) - English (United States)", "en-US")];
    voiceEvents.voicesChanged?.();

    expect(cancel).toHaveBeenCalledOnce();
    expect(speak).toHaveBeenCalledOnce();
    const utterance = speak.mock.calls[0]?.[0] as SpeechSynthesisUtterance | undefined;
    expect(utterance?.voice?.name).toContain("Jenny");
  });
});
