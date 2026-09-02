/**
 * Per-turn system guidance for the browser hands-free conversation loop.
 * It is deliberately dynamic: a typed follow-up in the same session must not
 * inherit a voice-only response contract.
 */
export const HANDS_FREE_VOICE_HANDOFF_PROMPT = [
  "This is a hands-free dictated turn.",
  "Follow the hands-free-conversation skill for this response.",
  "After completing the work, begin the final response with exactly one `Voice handoff:` paragraph.",
  "Make it one or two natural sentences, at most 60 words, stating the result and the next useful step.",
  "Do not put reasoning, tool output, progress commentary, secrets, or unsupported claims in that paragraph.",
  "Put any detail after a blank line; the client will speak only the Voice handoff paragraph.",
].join(" ");

export function buildHandsFreeVoiceHandoffPrompt(requested: boolean | undefined): string {
  return requested ? HANDS_FREE_VOICE_HANDOFF_PROMPT : "";
}
