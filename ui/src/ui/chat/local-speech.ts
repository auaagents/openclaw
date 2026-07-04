// Control UI chat module implements local browser speech helpers.
import { getSafeLocalStorage } from "../../local-storage.ts";
import { extractTextCached } from "./message-extract.ts";
import { normalizeRoleForGrouping } from "./role-normalizer.ts";

const LOCAL_SPEECH_SETTINGS_KEY = "openclaw:control-ui:local-speech:settings:v1";
const LOCAL_SPEECH_HEARD_KEY = "openclaw:control-ui:local-speech:heard:v1";
const MAX_HEARD_MESSAGE_IDS = 500;
const JENNY_VOICE_WAIT_MS = 700;

type SpeechRecognitionAlternativeLike = {
  transcript?: string;
};

type SpeechRecognitionResultLike = {
  readonly isFinal?: boolean;
  readonly length?: number;
  [index: number]: SpeechRecognitionAlternativeLike | undefined;
};

export type BrowserSpeechRecognitionResultEvent = {
  readonly resultIndex?: number;
  readonly results?: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike | undefined;
  };
};

export type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type BrowserSpeechWindow = typeof globalThis & {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
};

export type LocalSpeechSettings = {
  dictationEnabled: boolean;
  ttsEnabled: boolean;
};

export type SpeechMessageCandidate = {
  id: string;
  role: string;
  text: string;
  timestamp: number | null;
};

const DEFAULT_LOCAL_SPEECH_SETTINGS: LocalSpeechSettings = {
  dictationEnabled: false,
  ttsEnabled: false,
};

function parseBooleanRecord(value: unknown): Partial<LocalSpeechSettings> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.dictationEnabled === "boolean"
      ? { dictationEnabled: record.dictationEnabled }
      : {}),
    ...(typeof record.ttsEnabled === "boolean" ? { ttsEnabled: record.ttsEnabled } : {}),
  };
}

export function loadLocalSpeechSettings(): LocalSpeechSettings {
  try {
    const raw = getSafeLocalStorage()?.getItem(LOCAL_SPEECH_SETTINGS_KEY);
    if (!raw) {
      return DEFAULT_LOCAL_SPEECH_SETTINGS;
    }
    const parsed = parseBooleanRecord(JSON.parse(raw));
    return { ...DEFAULT_LOCAL_SPEECH_SETTINGS, ...(parsed ?? {}) };
  } catch {
    return DEFAULT_LOCAL_SPEECH_SETTINGS;
  }
}

export function saveLocalSpeechSettings(settings: LocalSpeechSettings): void {
  try {
    getSafeLocalStorage()?.setItem(LOCAL_SPEECH_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Persistence is optional; the in-memory toggle still works.
  }
}

export function createBrowserSpeechRecognition(): BrowserSpeechRecognition | null {
  const speechGlobal = globalThis as BrowserSpeechWindow;
  const Ctor = speechGlobal.SpeechRecognition ?? speechGlobal.webkitSpeechRecognition;
  if (!Ctor) {
    return null;
  }
  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  return recognition;
}

export function collectSpeechRecognitionText(event: BrowserSpeechRecognitionResultEvent): {
  finalText: string;
  interimText: string;
} {
  const results = event.results;
  if (!results) {
    return { finalText: "", interimText: "" };
  }
  const finalParts: string[] = [];
  const interimParts: string[] = [];
  const start = Math.max(0, Math.floor(event.resultIndex ?? 0));
  for (let index = start; index < results.length; index += 1) {
    const result = results[index];
    if (!result) {
      continue;
    }
    const transcript = result[0]?.transcript?.trim();
    if (!transcript) {
      continue;
    }
    if (result.isFinal) {
      finalParts.push(transcript);
    } else {
      interimParts.push(transcript);
    }
  }
  return {
    finalText: finalParts.join(" ").trim(),
    interimText: interimParts.join(" ").trim(),
  };
}

function replacePunctuationCommands(input: string): string {
  return input
    .replace(/\bnew paragraph\b/gi, "\n\n")
    .replace(/\b(?:new line|newline)\b/gi, "\n")
    .replace(/\b(?:period|full stop)\b/gi, ".")
    .replace(/\bcomma\b/gi, ",")
    .replace(/\bquestion mark\b/gi, "?")
    .replace(/\b(?:exclamation point|exclamation mark)\b/gi, "!")
    .replace(/\bsemicolon\b/gi, ";")
    .replace(/\bcolon\b/gi, ":")
    .replace(/\b(?:dash|hyphen)\b/gi, "-")
    .replace(/\bopen (?:parenthesis|paren)\b/gi, "(")
    .replace(/\bclose (?:parenthesis|paren)\b/gi, ")")
    .replace(/\bopen quote\b/gi, '"')
    .replace(/\bclose quote\b/gi, '"');
}

function cleanDictationSpacing(input: string): string {
  return input
    .replace(/[ \t]+([,.;:?!%)\]}])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/([,.;:?!])([^\s\n])/g, "$1 $2")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function capitalizeDictation(text: string, capitalizeFirst: boolean): string {
  let shouldCapitalize = capitalizeFirst;
  let output = "";
  for (const char of text) {
    if (/[A-Za-z]/.test(char)) {
      output += shouldCapitalize ? char.toUpperCase() : char;
      shouldCapitalize = false;
      continue;
    }
    output += char;
    if (char === "." || char === "?" || char === "!" || char === "\n") {
      shouldCapitalize = true;
    }
  }
  return output;
}

export function formatDictationTranscript(input: string, existingText = ""): string {
  const cleaned = cleanDictationSpacing(replacePunctuationCommands(input.trim()));
  if (!cleaned) {
    return "";
  }
  return capitalizeDictation(cleaned, !existingText.trim() || /[.!?\n]\s*$/.test(existingText));
}

export function appendDictationText(current: string, addition: string): string {
  if (!addition.trim()) {
    return current;
  }
  if (!current.trim()) {
    return addition.trimStart();
  }
  const trimmedRight = current.replace(/[ \t]+$/g, "");
  if (/^[,.;:?!%)\]}]/.test(addition) || addition.startsWith("\n")) {
    return `${trimmedRight}${addition}`;
  }
  return /[\s([{]$/.test(current) ? `${current}${addition}` : `${current} ${addition}`;
}

export function isDictationSubmitCommand(input: string): boolean {
  const command = input
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
  return /^(?:send|submit)\s+(?:(?:a|the)\s+)?(?:message|prompt)$/.test(command);
}

function messageRecord(message: unknown): Record<string, unknown> | null {
  return message && typeof message === "object" && !Array.isArray(message)
    ? (message as Record<string, unknown>)
    : null;
}

function messageTimestamp(message: unknown): number | null {
  const timestamp = messageRecord(message)?.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function resolveSpeechMessageId(
  sessionKey: string,
  message: unknown,
  fallbackKey?: string,
): string {
  const record = messageRecord(message);
  const transcriptMeta = messageRecord(record?.__openclaw);
  const transcriptId = typeof transcriptMeta?.id === "string" ? transcriptMeta.id.trim() : "";
  if (transcriptId) {
    return `${sessionKey}:${transcriptId}`;
  }
  const messageId = typeof record?.messageId === "string" ? record.messageId.trim() : "";
  if (messageId) {
    return `${sessionKey}:${messageId}`;
  }
  if (fallbackKey?.trim()) {
    return `${sessionKey}:${fallbackKey.trim()}`;
  }
  const role = typeof record?.role === "string" ? record.role : "unknown";
  const timestamp = messageTimestamp(message) ?? "no-time";
  const text = extractTextCached(message)?.trim() ?? "";
  return `${sessionKey}:${role}:${timestamp}:${hashString(text.slice(0, 500))}`;
}

export function speechTextForMessage(message: unknown): string | null {
  const text = extractTextCached(message)?.trim();
  return text || null;
}

export function speechTextForMessages(messages: readonly unknown[]): string | null {
  const parts = messages
    .map((message) => speechTextForMessage(message))
    .filter((text): text is string => Boolean(text));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function findLatestSpeechMessage(
  sessionKey: string,
  messages: readonly unknown[],
  options: { roles?: readonly string[] } = {},
): SpeechMessageCandidate | null {
  const allowedRoles = options.roles
    ? new Set(options.roles.map((role) => normalizeRoleForGrouping(role)))
    : null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const record = messageRecord(message);
    const role = normalizeRoleForGrouping(typeof record?.role === "string" ? record.role : "");
    if (allowedRoles && !allowedRoles.has(role)) {
      continue;
    }
    const text = speechTextForMessage(message);
    if (!text) {
      continue;
    }
    return {
      id: resolveSpeechMessageId(sessionKey, message),
      role,
      text,
      timestamp: messageTimestamp(message),
    };
  }
  return null;
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function loadHeardSpeechMessageIds(): Set<string> {
  return new Set(parseStringArray(getSafeLocalStorage()?.getItem(LOCAL_SPEECH_HEARD_KEY)));
}

export function saveHeardSpeechMessageIds(ids: ReadonlySet<string>): void {
  try {
    const values = [...ids].slice(-MAX_HEARD_MESSAGE_IDS);
    getSafeLocalStorage()?.setItem(LOCAL_SPEECH_HEARD_KEY, JSON.stringify(values));
  } catch {
    // Heard tracking is only used to avoid surprise repeat speech.
  }
}

export function rememberHeardSpeechMessageId(ids: Set<string>, id: string): void {
  ids.delete(id);
  ids.add(id);
  while (ids.size > MAX_HEARD_MESSAGE_IDS) {
    const first = ids.values().next().value;
    if (typeof first !== "string") {
      break;
    }
    ids.delete(first);
  }
  saveHeardSpeechMessageIds(ids);
}

export function selectJennyVoice(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  const jenny = selectExactJennyVoice(voices);
  if (jenny) {
    return jenny;
  }
  const englishVoices = voices.filter((voice) => /^en(?:-|_)?/i.test(voice.lang));
  const candidates = englishVoices.length > 0 ? englishVoices : voices;
  return (
    candidates.find((voice) => /microsoft/i.test(voice.name) && /en-us/i.test(voice.lang)) ??
    candidates.find((voice) => /en-us/i.test(voice.lang)) ??
    candidates[0] ??
    null
  );
}

function selectExactJennyVoice(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  const englishVoices = voices.filter((voice) => /^en(?:-|_)?/i.test(voice.lang));
  const candidates = englishVoices.length > 0 ? englishVoices : voices;
  return (
    candidates.find((voice) => /microsoft/i.test(voice.name) && /jenny/i.test(voice.name)) ??
    candidates.find((voice) => /jenny/i.test(voice.name)) ??
    null
  );
}

export function speakWithLocalVoice(params: {
  text: string;
  onEnd?: () => void;
  onError?: (error: string) => void;
  shouldSpeak?: () => boolean;
}): SpeechSynthesisUtterance | null {
  const synth = globalThis.speechSynthesis;
  if (!synth) {
    params.onError?.("Speech synthesis is not available in this browser.");
    return null;
  }
  const utterance = new SpeechSynthesisUtterance(params.text);
  utterance.rate = 1;
  utterance.pitch = 1;
  utterance.addEventListener("end", () => params.onEnd?.());
  utterance.addEventListener("error", (event) => {
    const speechEvent = event as SpeechSynthesisErrorEvent;
    const error =
      typeof speechEvent.error === "string" ? speechEvent.error : "Speech synthesis failed.";
    params.onError?.(error);
  });

  let started = false;
  let fallbackTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const removeVoiceListener =
    typeof synth.removeEventListener === "function"
      ? () => synth.removeEventListener("voiceschanged", handleVoicesChanged)
      : () => {};
  const cleanup = () => {
    if (fallbackTimer !== null) {
      globalThis.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    removeVoiceListener();
  };
  const startSpeaking = () => {
    if (started) {
      return;
    }
    started = true;
    cleanup();
    if (params.shouldSpeak && !params.shouldSpeak()) {
      params.onEnd?.();
      return;
    }
    utterance.voice = selectJennyVoice(synth.getVoices()) ?? null;
    synth.cancel();
    synth.speak(utterance);
  };
  function handleVoicesChanged() {
    if (selectExactJennyVoice(synth.getVoices())) {
      startSpeaking();
    }
  }

  if (selectExactJennyVoice(synth.getVoices())) {
    startSpeaking();
  } else if (typeof synth.addEventListener === "function") {
    synth.addEventListener("voiceschanged", handleVoicesChanged);
    fallbackTimer = globalThis.setTimeout(startSpeaking, JENNY_VOICE_WAIT_MS);
  } else {
    startSpeaking();
  }
  return utterance;
}
