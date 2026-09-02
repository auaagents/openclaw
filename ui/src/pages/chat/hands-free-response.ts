import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAssistantMessagePhase } from "../../../../src/shared/chat-message-content.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";

const MAX_READBACK_CHARS = 420;

type TtsSpeakResult = {
  audioBase64?: unknown;
  mimeType?: unknown;
};

export type HandsFreeAssistantResponse = {
  key: string;
  text: string;
};

function cleanReadbackText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " Code details are available in the chat. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gmu, "")
    .replace(/^\s*[-*+]\s+/gmu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Makes a short, deterministic spoken handoff without asking another model to
 * summarize. The source is already the final assistant phase, so reasoning,
 * commentary, and tool output cannot reach speech.
 */
export function summarizeHandsFreeResponse(text: string): string | null {
  const cleaned = cleanReadbackText(text);
  if (!cleaned) {
    return null;
  }
  const sentences = cleaned.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [cleaned];
  const selected = sentences
    .slice(0, 2)
    .map((sentence) => sentence.trim())
    .join(" ")
    .trim();
  const clipped =
    selected.length > MAX_READBACK_CHARS
      ? `${selected
          .slice(0, MAX_READBACK_CHARS)
          .replace(/\s+\S*$/u, "")
          .trim()}…`
      : selected;
  return clipped ? `Response complete. ${clipped}` : "Response complete.";
}

/** Returns only the latest visible final assistant reply, never commentary. */
export function findLatestHandsFreeAssistantResponse(
  messages: readonly unknown[],
): HandsFreeAssistantResponse | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const identity = readSessionMessageIdentity(message);
    if (identity?.role !== "assistant" || resolveAssistantMessagePhase(message) === "commentary") {
      continue;
    }
    const text = extractTextCached(message)?.trim();
    if (!text) {
      continue;
    }
    const record = asNullableRecord(message);
    const key =
      identity.id ??
      (identity.sequence !== null ? `seq:${identity.sequence}` : null) ??
      (typeof record?.id === "string" && record.id.trim() ? `message:${record.id.trim()}` : null) ??
      `index:${index}:${text}`;
    return { key, text };
  }
  return null;
}

/**
 * Plays a completion readback with the bundled Microsoft Edge TTS provider.
 * A monotonically increasing generation cancels stale playback, so concurrent
 * renders and a manual dictation stop can never overlap paragraphs.
 */
export class HandsFreeResponseSpeaker {
  private generation = 0;
  private audio: HTMLAudioElement | null = null;
  private audioCleanup: (() => void) | null = null;
  private finishPlayback: (() => void) | null = null;

  constructor(private readonly client: GatewayBrowserClient | null) {}

  stop(): void {
    this.generation += 1;
    this.finishPlayback?.();
    this.finishPlayback = null;
    this.audioCleanup?.();
    this.audioCleanup = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
      this.audio = null;
    }
    globalThis.speechSynthesis?.cancel();
  }

  async speak(finalText: string): Promise<void> {
    const summary = summarizeHandsFreeResponse(finalText);
    if (!summary) {
      return;
    }
    this.stop();
    const generation = this.generation;
    const playedMicrosoftClip = await this.playMicrosoftClip(summary, generation);
    if (playedMicrosoftClip || generation !== this.generation) {
      return;
    }
    await this.playBrowserFallback(summary, generation);
  }

  private async playMicrosoftClip(summary: string, generation: number): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    try {
      const result = await this.client.request<TtsSpeakResult>("tts.speak", {
        text: summary,
        provider: "microsoft",
        voiceId: "en-US-JennyNeural",
      });
      if (generation !== this.generation || typeof result.audioBase64 !== "string") {
        return generation !== this.generation;
      }
      const mimeType = typeof result.mimeType === "string" ? result.mimeType : "audio/mpeg";
      return await this.playAudio(`data:${mimeType};base64,${result.audioBase64}`, generation);
    } catch {
      return false;
    }
  }

  private async playAudio(src: string, generation: number): Promise<boolean> {
    if (typeof globalThis.Audio !== "function") {
      return false;
    }
    const audio = new globalThis.Audio(src);
    this.audio = audio;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        if (this.audioCleanup === cleanup) {
          this.audioCleanup = null;
        }
        if (this.audio === audio) {
          this.audio = null;
        }
      };
      const finish = (played: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (this.finishPlayback === cancel) {
          this.finishPlayback = null;
        }
        resolve(played && generation === this.generation);
      };
      const cancel = () => finish(false);
      const onEnded = () => finish(true);
      const onError = () => finish(false);
      this.audioCleanup = cleanup;
      this.finishPlayback = cancel;
      audio.addEventListener("ended", onEnded, { once: true });
      audio.addEventListener("error", onError, { once: true });
      void audio.play().catch(cancel);
    });
  }

  private async playBrowserFallback(summary: string, generation: number): Promise<void> {
    const synth = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (!synth || !Utterance || generation !== this.generation) {
      return;
    }
    await new Promise<void>((resolve) => {
      const utterance = new Utterance(summary);
      utterance.lang = "en-US";
      const jenny = synth.getVoices().find((voice) => /jenny/i.test(voice.name));
      if (jenny) {
        utterance.voice = jenny;
      }
      let settled = false;
      const cleanup = () => {
        utterance.removeEventListener("end", finish);
        utterance.removeEventListener("error", finish);
      };
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (this.finishPlayback === cancel) {
          this.finishPlayback = null;
        }
        resolve();
      };
      const cancel = () => finish();
      this.finishPlayback = cancel;
      utterance.addEventListener("end", finish, { once: true });
      utterance.addEventListener("error", finish, { once: true });
      synth.speak(utterance);
    });
  }
}
