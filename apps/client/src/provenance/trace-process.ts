/** Client-facing surface for the shared protocol process reader. */
export {
  renderTraceProcessLog,
  renderTraceProcessSummary,
  summarizeTraceProcess,
  traceProcessFromEvent,
} from "@zine/protocol";
export type {
  TraceProcessChange,
  TraceProcessLogStep,
  TraceProcessSummary,
  TraceProcessTransaction,
  TraceProcessView,
} from "@zine/protocol";
