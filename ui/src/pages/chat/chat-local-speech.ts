import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  appendDictationText,
  collectSpeechRecognitionText,
  createBrowserSpeechRecognition,
  findLatestSpeechMessage,
  formatDictationTranscript,
  isDictationSubmitCommand,
  loadHeardSpeechMessageIds,
  loadLocalSpeechSettings,
  rememberHeardSpeechMessageId,
  saveLocalSpeechSettings,
  speakWithLocalVoice,
  speechTextForMessages,
  type BrowserSpeechRecognition,
} from "./local-speech.ts";

const LOCAL_TTS_NEW_MESSAGE_SKEW_MS = 5_000;
const LOCAL_TTS_PROVIDER = "microsoft";
const LOCAL_TTS_VOICE_ID = "en-US-JennyNeural";
const LOCAL_TTS_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

type TalkSpeakResult = {
  audioBase64?: string;
  mimeType?: string;
};

export type ChatLocalSpeechState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  chatMessage: string;
  chatMessages: unknown[];
  localDictationEnabled: boolean;
  localDictationInterim: string | null;
  localDictationError: string | null;
  localTtsEnabled: boolean;
  localTtsSpeakingMessageId: string | null;
  localTtsError: string | null;
  localSpeechRecognition: BrowserSpeechRecognition | null;
  localSpeechRecognitionRestartTimer: number | null;
  localTtsActivatedAtMs: number;
  localTtsHeardMessageIds: Set<string>;
  localTtsObservedLatestBySession: Map<string, string>;
  localTtsSpeakToken: number;
  localTtsAudio: HTMLAudioElement | null;
  requestUpdate: () => void;
  handleChatDraftChange: (next: string) => void;
  handleSendChat: (messageOverride?: string, options?: unknown) => Promise<void>;
  startLocalDictation: (options?: { preserveEnabled?: boolean }) => void;
  stopLocalDictation: (options?: { persist?: boolean }) => void;
  toggleLocalDictation: () => void;
  toggleLocalTts: () => void;
  readLocalMessageGroup: (group: { key: string; messages: unknown[] }) => void;
  isReadingLocalMessageGroup: (groupKey: string) => boolean;
  syncLocalTtsAutoRead: () => void;
  stopLocalSpeechEffects: () => void;
};

export function createInitialChatLocalSpeechState() {
  const settings = loadLocalSpeechSettings();
  return {
    localDictationEnabled: settings.dictationEnabled,
    localDictationInterim: null,
    localDictationError: null,
    localTtsEnabled: settings.ttsEnabled,
    localTtsSpeakingMessageId: null,
    localTtsError: null,
    localSpeechRecognition: null as BrowserSpeechRecognition | null,
    localSpeechRecognitionRestartTimer: null as number | null,
    localTtsActivatedAtMs: settings.ttsEnabled ? Date.now() : 0,
    localTtsHeardMessageIds: loadHeardSpeechMessageIds(),
    localTtsObservedLatestBySession: new Map<string, string>(),
    localTtsSpeakToken: 0,
    localTtsAudio: null as HTMLAudioElement | null,
  };
}

function saveLocalSettings(state: ChatLocalSpeechState) {
  saveLocalSpeechSettings({
    dictationEnabled: state.localDictationEnabled,
    ttsEnabled: state.localTtsEnabled,
  });
}

function clearLocalDictationRestartTimer(state: ChatLocalSpeechState) {
  if (state.localSpeechRecognitionRestartTimer !== null) {
    window.clearTimeout(state.localSpeechRecognitionRestartTimer);
    state.localSpeechRecognitionRestartTimer = null;
  }
}

function startLocalDictation(
  state: ChatLocalSpeechState,
  options: { preserveEnabled?: boolean } = {},
) {
  if (state.localSpeechRecognition) {
    return;
  }
  clearLocalDictationRestartTimer(state);
  const recognition = createBrowserSpeechRecognition();
  if (!recognition) {
    state.localDictationEnabled = false;
    state.localDictationInterim = null;
    state.localDictationError = "Local dictation needs Chrome or Edge speech recognition support.";
    saveLocalSettings(state);
    state.requestUpdate();
    return;
  }
  recognition.onresult = (event) => {
    const { finalText, interimText } = collectSpeechRecognitionText(event);
    state.localDictationInterim = interimText || null;
    if (!finalText) {
      state.requestUpdate();
      return;
    }
    if (isDictationSubmitCommand(finalText)) {
      state.localDictationInterim = null;
      void state.handleSendChat();
      state.requestUpdate();
      return;
    }
    const addition = formatDictationTranscript(finalText, state.chatMessage);
    const next = appendDictationText(state.chatMessage, addition);
    state.localDictationInterim = null;
    if (next !== state.chatMessage) {
      state.handleChatDraftChange(next);
    }
    state.requestUpdate();
  };
  recognition.onerror = (event) => {
    if (event.error === "no-speech") {
      state.localDictationError = null;
      state.localDictationInterim = null;
      state.requestUpdate();
      return;
    }
    const message = event.message?.trim() || event.error?.trim() || "Dictation stopped.";
    state.localDictationError = message;
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      state.localDictationEnabled = false;
      state.localSpeechRecognition = null;
      saveLocalSettings(state);
    }
    state.requestUpdate();
  };
  recognition.onend = () => {
    if (state.localSpeechRecognition !== recognition || !state.localDictationEnabled) {
      return;
    }
    state.localSpeechRecognitionRestartTimer = window.setTimeout(() => {
      state.localSpeechRecognitionRestartTimer = null;
      if (state.localSpeechRecognition !== recognition || !state.localDictationEnabled) {
        return;
      }
      try {
        recognition.start();
      } catch (error) {
        state.localDictationError = error instanceof Error ? error.message : String(error);
        state.localDictationEnabled = false;
        state.localSpeechRecognition = null;
        saveLocalSettings(state);
        state.requestUpdate();
      }
    }, 250);
  };
  state.localSpeechRecognition = recognition;
  state.localDictationError = null;
  state.localDictationInterim = null;
  state.localDictationEnabled = true;
  try {
    recognition.start();
    saveLocalSettings(state);
  } catch (error) {
    state.localDictationError = error instanceof Error ? error.message : String(error);
    state.localSpeechRecognition = null;
    if (!options.preserveEnabled) {
      state.localDictationEnabled = false;
    }
    saveLocalSettings(state);
  }
  state.requestUpdate();
}

function stopLocalDictation(state: ChatLocalSpeechState, options: { persist?: boolean } = {}) {
  clearLocalDictationRestartTimer(state);
  const recognition = state.localSpeechRecognition;
  state.localSpeechRecognition = null;
  state.localDictationEnabled = false;
  state.localDictationInterim = null;
  if (recognition) {
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {}
  }
  if (options.persist !== false) {
    saveLocalSettings(state);
  }
  state.requestUpdate();
}

function stopLocalTtsPlayback(state: ChatLocalSpeechState) {
  const audio = state.localTtsAudio;
  state.localTtsAudio = null;
  if (audio) {
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch {}
  }
  globalThis.speechSynthesis?.cancel();
}

function isActiveLocalTts(
  state: ChatLocalSpeechState,
  messageId: string,
  speakToken: number,
): boolean {
  return state.localTtsSpeakingMessageId === messageId && state.localTtsSpeakToken === speakToken;
}

function speakLocalBrowserFallback(
  state: ChatLocalSpeechState,
  messageId: string,
  text: string,
  speakToken: number,
) {
  const utterance = speakWithLocalVoice({
    text,
    shouldSpeak: () => isActiveLocalTts(state, messageId, speakToken),
    onEnd: () => {
      if (isActiveLocalTts(state, messageId, speakToken)) {
        state.localTtsSpeakingMessageId = null;
        state.requestUpdate();
      }
    },
    onError: (error) => {
      state.localTtsError = error;
      if (isActiveLocalTts(state, messageId, speakToken)) {
        state.localTtsSpeakingMessageId = null;
      }
      state.requestUpdate();
    },
  });
  if (!utterance) {
    if (isActiveLocalTts(state, messageId, speakToken)) {
      state.localTtsSpeakingMessageId = null;
      state.requestUpdate();
    }
    return;
  }
  rememberHeardSpeechMessageId(state.localTtsHeardMessageIds, messageId);
}

async function trySpeakGatewayText(
  state: ChatLocalSpeechState,
  messageId: string,
  text: string,
  speakToken: number,
): Promise<boolean> {
  if (!state.client || !state.connected || typeof Audio === "undefined") {
    return false;
  }
  let result: TalkSpeakResult;
  try {
    result = await state.client.request<TalkSpeakResult>("talk.speak", {
      text,
      provider: LOCAL_TTS_PROVIDER,
      voiceId: LOCAL_TTS_VOICE_ID,
      outputFormat: LOCAL_TTS_OUTPUT_FORMAT,
    });
  } catch {
    if (isActiveLocalTts(state, messageId, speakToken)) {
      state.localTtsError = "Jenny Neural read-aloud unavailable; using browser voice.";
      state.requestUpdate();
    }
    return false;
  }
  if (!isActiveLocalTts(state, messageId, speakToken)) {
    return true;
  }
  const audioBase64 = result.audioBase64?.trim();
  if (!audioBase64) {
    state.localTtsError = "Jenny Neural read-aloud returned no audio; using browser voice.";
    state.requestUpdate();
    return false;
  }
  const mimeType = result.mimeType?.trim() || "audio/mpeg";
  const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
  state.localTtsAudio = audio;

  try {
    await new Promise<void>((resolve, reject) => {
      audio.addEventListener("ended", () => resolve(), { once: true });
      audio.addEventListener("pause", () => {
        if (!isActiveLocalTts(state, messageId, speakToken)) {
          resolve();
        }
      });
      audio.addEventListener("error", () => reject(new Error("Jenny playback failed.")), {
        once: true,
      });
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === "function") {
        playResult.catch(reject);
      }
    });
  } catch {
    if (isActiveLocalTts(state, messageId, speakToken)) {
      state.localTtsError = "Jenny Neural read-aloud could not play; using browser voice.";
      state.requestUpdate();
    }
    return false;
  } finally {
    if (state.localTtsAudio === audio) {
      state.localTtsAudio = null;
    }
  }

  if (isActiveLocalTts(state, messageId, speakToken)) {
    state.localTtsSpeakingMessageId = null;
    rememberHeardSpeechMessageId(state.localTtsHeardMessageIds, messageId);
    state.requestUpdate();
  }
  return true;
}

function speakLocalText(state: ChatLocalSpeechState, messageId: string, text: string) {
  if (state.localTtsSpeakingMessageId === messageId) {
    state.localTtsSpeakToken += 1;
    stopLocalTtsPlayback(state);
    state.localTtsSpeakingMessageId = null;
    state.requestUpdate();
    return;
  }
  state.localTtsError = null;
  const speakToken = state.localTtsSpeakToken + 1;
  state.localTtsSpeakToken = speakToken;
  state.localTtsSpeakingMessageId = messageId;
  state.requestUpdate();
  void (async () => {
    const spokeWithGateway = await trySpeakGatewayText(state, messageId, text, speakToken);
    if (spokeWithGateway || !isActiveLocalTts(state, messageId, speakToken)) {
      return;
    }
    speakLocalBrowserFallback(state, messageId, text, speakToken);
  })();
}

function readLatestLocalTtsMessage(state: ChatLocalSpeechState, options: { force?: boolean } = {}) {
  const candidate = findLatestSpeechMessage(state.sessionKey, state.chatMessages, {
    roles: ["assistant"],
  });
  if (!candidate) {
    if (options.force) {
      state.localTtsError = "No assistant message to read yet.";
      state.requestUpdate();
    }
    return;
  }
  state.localTtsObservedLatestBySession.set(state.sessionKey, candidate.id);
  if (!options.force && state.localTtsHeardMessageIds.has(candidate.id)) {
    return;
  }
  speakLocalText(state, candidate.id, candidate.text);
}

export function attachChatLocalSpeechActions(state: ChatLocalSpeechState) {
  state.startLocalDictation = (options) => startLocalDictation(state, options);
  state.stopLocalDictation = (options) => stopLocalDictation(state, options);
  state.toggleLocalDictation = () => {
    if (state.localDictationEnabled) {
      stopLocalDictation(state);
      return;
    }
    startLocalDictation(state);
  };
  state.toggleLocalTts = () => {
    if (state.localTtsEnabled) {
      state.localTtsEnabled = false;
      state.localTtsError = null;
      state.localTtsSpeakToken += 1;
      state.localTtsSpeakingMessageId = null;
      stopLocalTtsPlayback(state);
      saveLocalSettings(state);
      state.requestUpdate();
      return;
    }
    state.localTtsEnabled = true;
    state.localTtsActivatedAtMs = Date.now();
    saveLocalSettings(state);
    readLatestLocalTtsMessage(state, { force: true });
    state.requestUpdate();
  };
  state.readLocalMessageGroup = (group) => {
    const text = speechTextForMessages(group.messages);
    if (!text) {
      state.localTtsError = "No readable text in this message.";
      state.requestUpdate();
      return;
    }
    const messageId = `${state.sessionKey}:${group.key}`;
    state.localTtsObservedLatestBySession.set(state.sessionKey, messageId);
    speakLocalText(state, messageId, text);
  };
  state.isReadingLocalMessageGroup = (groupKey) =>
    state.localTtsSpeakingMessageId === `${state.sessionKey}:${groupKey}`;
  state.syncLocalTtsAutoRead = () => {
    if (!state.localTtsEnabled) {
      return;
    }
    const candidate = findLatestSpeechMessage(state.sessionKey, state.chatMessages, {
      roles: ["assistant"],
    });
    if (!candidate) {
      return;
    }
    const previousObserved = state.localTtsObservedLatestBySession.get(state.sessionKey);
    if (previousObserved === candidate.id) {
      return;
    }
    state.localTtsObservedLatestBySession.set(state.sessionKey, candidate.id);
    if (state.localTtsHeardMessageIds.has(candidate.id)) {
      return;
    }
    const isFresh =
      candidate.timestamp !== null &&
      candidate.timestamp >= state.localTtsActivatedAtMs - LOCAL_TTS_NEW_MESSAGE_SKEW_MS;
    if (!isFresh) {
      return;
    }
    speakLocalText(state, candidate.id, candidate.text);
  };
  state.stopLocalSpeechEffects = () => {
    stopLocalDictation(state, { persist: false });
    state.localTtsSpeakToken += 1;
    state.localTtsSpeakingMessageId = null;
    stopLocalTtsPlayback(state);
  };
}
