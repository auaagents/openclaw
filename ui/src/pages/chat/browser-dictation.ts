// Browser-hosted dictation for the Control UI. Edge exposes this as
// SpeechRecognition; Chromium exposes the historical webkit alias.

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

export type BrowserDictationFailure = {
  kind: "interrupted" | "start";
  preservesText: boolean;
};

export type BrowserDictationControllerOptions = {
  enabled: boolean;
  onCommit: (text: string) => void;
  /**
   * Runs only for an explicit final browser-speech command such as
   * "send message". The composer owns validation, so an empty draft remains
   * harmless and cannot create an empty run.
   */
  onSend: () => void;
  onError: (message: string, failure: BrowserDictationFailure) => void;
  onStateChange: () => void;
};

const RESTART_DELAY_MS = 250;

const BROWSER_DICTATION_SEND_COMMAND =
  "(?:send|submit)(?:\\s+(?:(?:a|the)\\s+)?(?:message|prompt|it|this))?";
const browserDictationSendCommand = new RegExp(`^${BROWSER_DICTATION_SEND_COMMAND}[.!?]*$`, "i");
const browserDictationSendCommandAfterPunctuation = new RegExp(
  `^([\\s\\S]*?(?:[.!?]+|\\b(?:period|full stop|question mark|exclamation point|exclamation mark|new line|newline|new paragraph)\\b))\\s+(${BROWSER_DICTATION_SEND_COMMAND})[.!?]*$`,
  "i",
);

function browserSpeechConstructor(): BrowserSpeechRecognitionConstructor | null {
  const speechGlobal = globalThis as BrowserSpeechWindow;
  return speechGlobal.SpeechRecognition ?? speechGlobal.webkitSpeechRecognition ?? null;
}

export function supportsBrowserDictation(): boolean {
  return browserSpeechConstructor() !== null;
}

export function createBrowserSpeechRecognition(): BrowserSpeechRecognition | null {
  const Ctor = browserSpeechConstructor();
  if (!Ctor) {
    return null;
  }
  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  return recognition;
}

export function collectBrowserSpeechRecognitionText(event: BrowserSpeechRecognitionResultEvent): {
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
    const transcript = result?.[0]?.transcript?.trim();
    if (!result || !transcript) {
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

/**
 * Recognize an intentionally spoken send command without treating ordinary
 * prose as executable. A command must be the entire final recognition result,
 * or follow explicit punctuation in that same result. This lets someone say
 * "summarize the update. Send prompt" hands-free, while prose such as
 * "please send message details to the team" stays in the draft.
 */
export function splitBrowserDictationSendCommand(input: string): {
  text: string;
  shouldSend: boolean;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    return { text: "", shouldSend: false };
  }
  if (browserDictationSendCommand.test(trimmed)) {
    return { text: "", shouldSend: true };
  }
  const match = trimmed.match(browserDictationSendCommandAfterPunctuation);
  if (!match?.[1]) {
    return { text: trimmed, shouldSend: false };
  }
  return { text: match[1].trim(), shouldSend: true };
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

export function formatBrowserDictationTranscript(input: string, existingText = ""): string {
  const cleaned = cleanDictationSpacing(replacePunctuationCommands(input.trim()));
  if (!cleaned) {
    return "";
  }
  return capitalizeDictation(cleaned, !existingText.trim() || /[.!?\n]\s*$/.test(existingText));
}

function dictationErrorMessage(error?: string, message?: string): string {
  if (message?.trim()) {
    return message.trim();
  }
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission was blocked for browser dictation.";
    case "audio-capture":
      return "No microphone is available for browser dictation.";
    case "network":
      return "Browser dictation could not reach its speech service.";
    default:
      return "Browser dictation stopped.";
  }
}

/**
 * Continuous browser speech recognition. It intentionally has the same public
 * UI contract as the gateway dictation controller, but never opens a Talk
 * session or sends captured audio to OpenClaw.
 */
export class BrowserDictationController {
  readonly source = "browser" as const;
  private options: BrowserDictationControllerOptions;
  private recognition: BrowserSpeechRecognition | null = null;
  private restartTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private listening = false;
  private interim = "";
  private disposed = false;

  constructor(options: BrowserDictationControllerOptions) {
    this.options = options;
  }

  get active(): boolean {
    return this.listening;
  }

  get connecting(): boolean {
    return false;
  }

  get arming(): boolean {
    return false;
  }

  get finalizing(): boolean {
    return false;
  }

  get locksComposer(): boolean {
    return this.listening;
  }

  get transcript(): string {
    return this.interim;
  }

  update(options: BrowserDictationControllerOptions): void {
    this.options = options;
    if (!options.enabled && this.listening) {
      void this.finishActive();
    }
  }

  handlePointerDown(event: PointerEvent): boolean {
    return event.button === 0 && !this.listening && this.options.enabled;
  }

  handleClick(event: MouseEvent): void {
    event.preventDefault();
    if (this.listening) {
      void this.finishActive();
      return;
    }
    this.startDirect();
  }

  handleContextMenu(event: MouseEvent): void {
    if (this.listening) {
      event.preventDefault();
    }
  }

  startDirect(): boolean {
    if (this.listening || !this.options.enabled || this.disposed) {
      return false;
    }
    const recognition = createBrowserSpeechRecognition();
    if (!recognition) {
      this.options.onError(
        "Browser dictation needs Microsoft Edge or Google Chrome speech recognition support.",
        { kind: "start", preservesText: false },
      );
      return false;
    }
    this.listening = true;
    this.interim = "";
    this.attachRecognition(recognition);
    this.options.onStateChange();
    try {
      recognition.start();
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error), "start");
      return false;
    }
  }

  finishActive(): Promise<boolean> {
    if (!this.listening) {
      return Promise.resolve(false);
    }
    this.stop();
    return Promise.resolve(true);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private attachRecognition(recognition: BrowserSpeechRecognition): void {
    this.recognition = recognition;
    recognition.onresult = (event) => {
      if (this.recognition !== recognition || !this.listening) {
        return;
      }
      const { finalText, interimText } = collectBrowserSpeechRecognitionText(event);
      this.interim = interimText;
      if (finalText) {
        const { text, shouldSend } = splitBrowserDictationSendCommand(finalText);
        if (text) {
          this.options.onCommit(text);
        }
        if (shouldSend) {
          // Stop first so one stale browser event cannot add text after the
          // composer submits. onCommit is synchronous and updates the live
          // textarea before onSend reads it.
          this.stop();
          this.options.onSend();
          return;
        }
      }
      this.options.onStateChange();
    };
    recognition.onerror = (event) => {
      if (this.recognition !== recognition || !this.listening) {
        return;
      }
      if (event.error === "no-speech" || event.error === "aborted") {
        return;
      }
      this.fail(dictationErrorMessage(event.error, event.message), "interrupted");
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) {
        return;
      }
      this.recognition = null;
      this.interim = "";
      if (!this.listening || this.disposed) {
        this.options.onStateChange();
        return;
      }
      this.options.onStateChange();
      this.restartTimer = globalThis.setTimeout(() => {
        this.restartTimer = null;
        if (!this.listening || this.disposed || this.recognition) {
          return;
        }
        const replacement = createBrowserSpeechRecognition();
        if (!replacement) {
          this.fail(
            "Browser dictation needs Microsoft Edge or Google Chrome speech recognition support.",
            "interrupted",
          );
          return;
        }
        this.attachRecognition(replacement);
        try {
          replacement.start();
        } catch (error) {
          this.fail(error instanceof Error ? error.message : String(error), "interrupted");
        }
      }, RESTART_DELAY_MS);
    };
  }

  private fail(message: string, kind: BrowserDictationFailure["kind"]): void {
    const preservesText = Boolean(this.interim);
    this.stop();
    this.options.onError(message, { kind, preservesText });
  }

  private stop(): void {
    if (this.restartTimer !== null) {
      globalThis.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const recognition = this.recognition;
    this.recognition = null;
    this.listening = false;
    this.interim = "";
    recognition?.stop();
    this.options.onStateChange();
  }
}
