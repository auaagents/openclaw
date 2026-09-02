import {
  BrowserDictationController,
  type BrowserDictationControllerOptions,
} from "../browser-dictation.ts";
import { ComposerDictationController } from "../composer-dictation.ts";
import {
  findLatestHandsFreeAssistantResponse,
  HandsFreeResponseSpeaker,
} from "../hands-free-response.ts";
import { isChatRunWorking } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function submitHandsFreeDictation(params: {
  state: ChatComposerState;
  messages: readonly unknown[];
  submit: () => boolean;
}): boolean {
  const previousResponse = findLatestHandsFreeAssistantResponse(params.messages);
  const submitted = params.submit();
  if (submitted) {
    params.state.handsFreePendingResponse = {
      previousResponseKey: previousResponse?.key ?? null,
      observedWorking: false,
    };
  }
  return submitted;
}

export function createHandsFreeBrowserDictationOptions(params: {
  enabled: boolean;
  state: ChatComposerState;
  messages: readonly unknown[];
  onCommit: (transcript: string) => void;
  submit: () => boolean;
  onError: BrowserDictationControllerOptions["onError"];
  onStateChange: () => void;
}): BrowserDictationControllerOptions {
  return {
    enabled: params.enabled,
    onCommit: params.onCommit,
    onSend: () =>
      submitHandsFreeDictation({
        state: params.state,
        messages: params.messages,
        submit: params.submit,
      }),
    onError: params.onError,
    onStateChange: params.onStateChange,
  };
}

export function syncComposerDictationController(params: {
  state: ChatComposerState;
  source: "browser" | "gateway" | null;
  browserOptions: BrowserDictationControllerOptions;
  gatewayOptions: ConstructorParameters<typeof ComposerDictationController>[0];
}): BrowserDictationController | ComposerDictationController | undefined {
  if (params.state.dictationSource !== params.source) {
    params.state.dictation?.dispose();
    params.state.dictation = null;
    params.state.dictationSource = params.source;
    params.state.dictationSelection = null;
    params.state.handsFreeSpeaker?.stop();
    params.state.handsFreePendingResponse = null;
  }
  if (params.source === "browser") {
    if (!(params.state.dictation instanceof BrowserDictationController)) {
      params.state.dictation = new BrowserDictationController(params.browserOptions);
    } else {
      params.state.dictation.update(params.browserOptions);
    }
  } else if (params.source === "gateway") {
    if (!(params.state.dictation instanceof ComposerDictationController)) {
      params.state.dictation = new ComposerDictationController(params.gatewayOptions);
    } else {
      params.state.dictation.update(params.gatewayOptions);
    }
  }
  return params.state.dictation ?? undefined;
}

/**
 * Coordinates one browser-dictated turn with its final-only response readback.
 * It deliberately resumes capture only after speech settles, so neither Jenny
 * nor the browser fallback can feed audio back into the composer.
 */
export function advanceHandsFreeDictation(params: {
  state: ChatComposerState;
  props: Pick<ChatComposerProps, "gatewayClient" | "messages" | "runError">;
  dictation: BrowserDictationController | ComposerDictationController | undefined;
  working: boolean;
  hasTerminalStatus: boolean;
  requestUpdate: () => void;
}): void {
  const pending = params.state.handsFreePendingResponse;
  if (!pending) {
    return;
  }
  const dictation = params.dictation;
  if (!dictation?.active) {
    params.state.handsFreeSpeaker?.stop();
    params.state.handsFreePendingResponse = null;
    return;
  }
  if (params.working) {
    pending.observedWorking = true;
    return;
  }
  const response = findLatestHandsFreeAssistantResponse(params.props.messages);
  if (response && response.key !== pending.previousResponseKey) {
    params.state.handsFreePendingResponse = null;
    const speaker = (params.state.handsFreeSpeaker ??= new HandsFreeResponseSpeaker(
      params.props.gatewayClient ?? null,
    ));
    void speaker.speak(response.text).finally(() => {
      if (
        params.state.dictation === dictation &&
        dictation.active &&
        params.state.handsFreePendingResponse === null
      ) {
        dictation.resumeAfterResponse();
      }
      params.requestUpdate();
    });
    return;
  }
  if (pending.observedWorking || params.props.runError || params.hasTerminalStatus) {
    params.state.handsFreePendingResponse = null;
    dictation.resumeAfterResponse();
  }
}

export function advanceHandsFreeDictationForComposer(params: {
  state: ChatComposerState;
  props: Pick<
    ChatComposerProps,
    | "gatewayClient"
    | "messages"
    | "runError"
    | "canAbort"
    | "onAbort"
    | "runStatus"
    | "queue"
    | "sessionKey"
  >;
  dictation: BrowserDictationController | undefined;
  isBusy: boolean;
  hasTerminalStatus: boolean;
  requestUpdate: () => void;
}): void {
  advanceHandsFreeDictation({
    ...params,
    dictation:
      params.dictation instanceof BrowserDictationController ? params.dictation : undefined,
    working: params.isBusy || isChatRunWorking(params.props),
  });
}
