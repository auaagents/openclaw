import { html, nothing } from "lit";
import type { LlmTraceDetail, LlmTraceSummary, TraceCapability } from "../controllers/traces.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

export type TracesProps = {
  loading: boolean;
  error: string | null;
  capability: TraceCapability | null;
  entries: LlmTraceSummary[];
  selected: LlmTraceDetail | null;
  selectedId: string | null;
  filterText: string;
  onFilterTextChange: (next: string) => void;
  onRefresh: () => void;
  onSelect: (id: string) => void;
};

function formatTime(value?: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

function formatBytes(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "running";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  return `${(value / 1000).toFixed(2)} s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatJson(value: unknown): string {
  if (value === undefined) {
    return "Not captured";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return typeof value === "bigint" ? value.toString() : "[Unserializable value]";
  }
}

function requestInputs(trace: LlmTraceDetail | null): unknown {
  const payload = trace?.requestPayload;
  if (!isRecord(payload)) {
    return undefined;
  }
  return payload.input ?? payload.messages;
}

function requestTools(trace: LlmTraceDetail | null): unknown {
  const payload = trace?.requestPayload;
  if (!isRecord(payload)) {
    return undefined;
  }
  return payload.tools ?? payload.functions;
}

function requestParams(trace: LlmTraceDetail | null): unknown {
  const payload = trace?.requestPayload;
  if (!isRecord(payload)) {
    return undefined;
  }
  const {
    input: _input,
    messages: _messages,
    tools: _tools,
    functions: _functions,
    ...rest
  } = payload;
  return rest;
}

function matchesFilter(entry: LlmTraceSummary, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = normalizeLowercaseStringOrEmpty(
    [
      entry.id,
      entry.runId,
      entry.sessionKey,
      entry.provider,
      entry.model,
      entry.api,
      entry.status,
      entry.errorCategory,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return haystack.includes(needle);
}

function unavailableReason(capability: TraceCapability | null): string {
  if (!capability) {
    return "Tracing capability has not loaded yet.";
  }
  if (capability.reasons.length === 0) {
    return "Tracing is disabled.";
  }
  return capability.reasons.join(", ");
}

function renderTraceRows(
  entries: LlmTraceSummary[],
  selectedId: string | null,
  onSelect: (id: string) => void,
) {
  if (entries.length === 0) {
    return html`<div class="muted" style="padding: 14px;">No traces.</div>`;
  }
  return html`
    <div class="traces-table" role="list">
      ${entries.map(
        (entry) => html`
          <button
            class="traces-row ${entry.id === selectedId ? "selected" : ""}"
            data-traces-row=${entry.id}
            role="listitem"
            @click=${() => onSelect(entry.id)}
          >
            <span class="trace-status ${entry.status}">${entry.status}</span>
            <span class="trace-main">
              <span class="trace-name">${entry.provider}/${entry.model}</span>
              <span class="trace-meta mono">${entry.callId}</span>
            </span>
            <span class="trace-metric">${formatDuration(entry.durationMs)}</span>
            <span class="trace-metric">${entry.toolCount ?? 0} tools</span>
            <span class="trace-metric">${formatBytes(entry.requestPayloadBytes)}</span>
            <span class="trace-time">${formatTime(entry.startedAt)}</span>
          </button>
        `,
      )}
    </div>
  `;
}

function renderTraceDetail(trace: LlmTraceDetail | null, capability: TraceCapability | null) {
  if (!trace) {
    return html`<div class="traces-detail-empty muted">Select a trace.</div>`;
  }
  const inputs = requestInputs(trace);
  const tools = requestTools(trace);
  const params = requestParams(trace);
  return html`
    <section class="traces-detail">
      <div class="traces-detail-header">
        <div>
          <div class="card-title">${trace.provider}/${trace.model}</div>
          <div class="card-sub mono">${trace.callId}</div>
        </div>
        <div class="trace-status ${trace.status}">${trace.status}</div>
      </div>
      <div class="traces-summary-grid">
        <div><span>Duration</span><strong>${formatDuration(trace.durationMs)}</strong></div>
        <div><span>TTFB</span><strong>${formatDuration(trace.timeToFirstByteMs)}</strong></div>
        <div><span>Request</span><strong>${formatBytes(trace.requestPayloadBytes)}</strong></div>
        <div><span>Response</span><strong>${formatBytes(trace.responseStreamBytes)}</strong></div>
      </div>
      ${capability?.payloadCaptureEnabled
        ? nothing
        : html`<div class="callout" style="margin-top: 12px;">
            Raw prompt and tool payload capture is disabled.
          </div>`}
      <div class="traces-payload-grid">
        <section>
          <div class="traces-section-title">Prompt</div>
          <pre class="mono traces-json" data-traces-request-payload>${formatJson(inputs)}</pre>
        </section>
        <section>
          <div class="traces-section-title">Tools</div>
          <pre class="mono traces-json" data-traces-tools>${formatJson(tools)}</pre>
        </section>
        <section>
          <div class="traces-section-title">Parameters</div>
          <pre class="mono traces-json">${formatJson(params)}</pre>
        </section>
        <section>
          <div class="traces-section-title">Response Events</div>
          <pre class="mono traces-json">${formatJson(trace.responseChunks)}</pre>
        </section>
      </div>
    </section>
  `;
}

export function renderTraces(props: TracesProps) {
  const needle = normalizeLowercaseStringOrEmpty(props.filterText);
  const filtered = props.entries.filter((entry) => matchesFilter(entry, needle));
  const capability = props.capability;
  const available = capability?.available === true;

  return html`
    <section class="card traces-view">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Traces</div>
          <div class="card-sub">Development LLM request capture.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading" : "Refresh"}
        </button>
      </div>

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="min-width: 260px;">
          <span>Filter</span>
          <input
            .value=${props.filterText}
            @input=${(e: Event) => props.onFilterTextChange((e.target as HTMLInputElement).value)}
            placeholder="Search traces"
          />
        </label>
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
      ${!available
        ? html`<div class="callout" style="margin-top: 12px;">
            Tracing unavailable: ${unavailableReason(capability)}
          </div>`
        : nothing}

      <div class="traces-layout">
        <section class="traces-list">
          ${renderTraceRows(available ? filtered : [], props.selectedId, props.onSelect)}
        </section>
        ${renderTraceDetail(available ? props.selected : null, capability)}
      </div>
    </section>
  `;
}
