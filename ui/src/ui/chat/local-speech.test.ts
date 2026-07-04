// Control UI chat module tests local browser speech helpers.
import { describe, expect, it } from "vitest";
import {
  appendDictationText,
  findLatestSpeechMessage,
  formatDictationTranscript,
  selectJennyVoice,
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
});
