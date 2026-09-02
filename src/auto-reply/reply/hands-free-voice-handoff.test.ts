import { describe, expect, it } from "vitest";
import {
  buildHandsFreeVoiceHandoffPrompt,
  HANDS_FREE_VOICE_HANDOFF_PROMPT,
} from "./hands-free-voice-handoff.js";

describe("hands-free voice handoff prompt", () => {
  it("adds the durable skill contract only for a marked dictated turn", () => {
    expect(buildHandsFreeVoiceHandoffPrompt(true)).toBe(HANDS_FREE_VOICE_HANDOFF_PROMPT);
    expect(HANDS_FREE_VOICE_HANDOFF_PROMPT).toContain("hands-free-conversation skill");
    expect(HANDS_FREE_VOICE_HANDOFF_PROMPT).toContain("Voice handoff:");
    expect(buildHandsFreeVoiceHandoffPrompt(false)).toBe("");
    expect(buildHandsFreeVoiceHandoffPrompt(undefined)).toBe("");
  });
});
