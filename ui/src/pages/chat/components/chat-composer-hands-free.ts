import { patchSettings } from "../../../app/settings.ts";
import { t } from "../../../i18n/index.ts";
import {
  BrowserDictationController,
  formatBrowserDictationTranscript,
  supportsBrowserDictation,
  type BrowserDictationControllerOptions,
} from "../browser-dictation.ts";
import { ComposerDictationController, insertComposerDictation } from "../composer-dictation.ts";
import type { ComposerMicrophonePicker } from "../composer-microphone-picker.ts";
import {
  findLatestHandsFreeAssistantResponse,
  HandsFreeResponseSpeaker,
} from "../hands-free-response.ts";
import { renderMicrophonePicker } from "./chat-composer-controls.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { commitComposerDraft, isChatRunWorking } from "./chat-composer-state.ts";
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
  dictation: BrowserDictationController | undefined;
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
  dictation: BrowserDictationController | ComposerDictationController | undefined;
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

export function setupComposerDictation(params: {
  state: ChatComposerState;
  props: ChatComposerProps;
  visibleDraft: string;
  devicePicker: ComposerMicrophonePicker;
  startRealtimeTalk: () => void;
  handleVoicePrimaryAction: () => void;
  submitHandsFree: () => boolean;
  isBusy: boolean;
  hasTerminalStatus: boolean;
  requestUpdate: () => void;
}) {
  const { state, props, visibleDraft, devicePicker, requestUpdate } = params;
  const dictationSource = supportsBrowserDictation()
    ? "browser"
    : props.onToggleRealtimeTalk && props.composerHoldToRecord !== false
      ? "gateway"
      : null;
  const microphonePicker =
    props.onToggleRealtimeTalk && dictationSource !== "browser"
      ? renderMicrophonePicker({
          devices: devicePicker.devices,
          loading: devicePicker.loading,
          open: devicePicker.open,
          selectedDeviceId: props.realtimeTalkInputDeviceId?.trim() ?? "",
          voiceActive: Boolean(props.realtimeTalkActive),
          issue: devicePicker.issue,
          holdToDictate: props.composerHoldToRecord !== false,
          realtimeStatus: devicePicker.realtimeStatus,
          dictationStatus: devicePicker.dictationStatus,
          onOpen: devicePicker.handleOpen,
          onClose: devicePicker.handleClose,
          onSelect: (deviceId: string) => {
            patchSettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined });
            devicePicker.handleClose();
          },
          onHoldToDictateChange: (enabled: boolean) => {
            if (props.onComposerHoldToRecordChange) {
              props.onComposerHoldToRecordChange(enabled);
            } else {
              patchSettings({ composerHoldToRecord: enabled });
            }
            requestUpdate();
          },
          onOpenTalkSettings: props.onOpenTalkSettings,
          onOpenDictationSettings: props.onOpenDictationSettings,
        })
      : undefined;
  const commitDictation = (
    transcript: string,
    formatter?: (text: string, existing: string) => string,
    late?: true,
  ) => {
    const target = state.composerTextarea;
    const captured = state.dictationSelection;
    const liveValue = target?.value ?? props.getDraft?.() ?? props.draft;
    const selection =
      captured && (!late || captured.value === liveValue)
        ? captured
        : {
            start: target?.selectionStart ?? liveValue.length,
            end: target?.selectionEnd ?? liveValue.length,
            value: liveValue,
          };
    const formatted = formatter?.(transcript, selection.value) ?? transcript;
    if (!formatted) {
      return;
    }
    const insertion = insertComposerDictation(
      selection.value,
      formatted,
      selection.start,
      selection.end,
    );
    if (target) {
      target.value = insertion.value;
      adjustTextareaHeight(target);
    }
    commitComposerDraft(props, insertion.value);
    state.dictationSelection = null;
    requestUpdate();
    queueMicrotask(() => {
      const textarea = state.composerTextarea;
      if (!textarea) {
        return;
      }
      textarea.focus({ preventScroll: true });
      textarea.selectionStart = insertion.caret;
      textarea.selectionEnd = insertion.caret;
    });
  };
  const reportDictationError = (
    message: string,
    failure: { kind: "interrupted" | "start"; preservesText: boolean },
  ) => {
    const recovery =
      failure.kind === "interrupted" && failure.preservesText
        ? t("chat.composer.dictationInterruptedRecovery")
        : t("chat.composer.dictationStartRecovery");
    state.dictationError = `${message} ${recovery}`;
    requestUpdate();
  };
  const gatewayOptions = {
    client: props.gatewayClient ?? null,
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false,
    dictationAvailable: devicePicker.dictationStatus === "ready",
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string, late?: true) => commitDictation(transcript, undefined, late),
    onError: reportDictationError,
    onStateChange: () => {
      if (state.dictation?.locksComposer) {
        props.onDismissRealtimeTalkError?.();
      }
      requestUpdate();
    },
    onDictationUnavailable: devicePicker.handleOpen,
    onTap:
      visibleDraft.trim() || props.attachments?.length
        ? params.startRealtimeTalk
        : params.handleVoicePrimaryAction,
  };
  const browserOptions = createHandsFreeBrowserDictationOptions({
    enabled: props.realtimeTalkActive !== true,
    state,
    messages: props.messages,
    onCommit: (transcript) =>
      commitDictation(transcript, (text, existing) =>
        formatBrowserDictationTranscript(text, existing),
      ),
    submit: params.submitHandsFree,
    onError: reportDictationError,
    onStateChange: requestUpdate,
  });
  const dictation = syncComposerDictationController({
    state,
    source: dictationSource,
    browserOptions,
    gatewayOptions,
  });
  advanceHandsFreeDictationForComposer({
    state,
    props,
    dictation,
    isBusy: params.isBusy,
    hasTerminalStatus: params.hasTerminalStatus,
    requestUpdate,
  });
  const handleDictationPointerDown = (event: PointerEvent) => {
    if (state.dictationError) {
      state.dictationError = null;
      requestUpdate();
    }
    const target = state.composerTextarea;
    const selection = {
      start: target?.selectionStart ?? visibleDraft.length,
      end: target?.selectionEnd ?? visibleDraft.length,
      value: target?.value ?? visibleDraft,
    };
    if (dictation?.handlePointerDown(event)) {
      state.dictationSelection = selection;
      if (target) {
        target.readOnly = true;
      }
    }
  };
  return { microphonePicker, dictation, dictationSource, handleDictationPointerDown };
}
