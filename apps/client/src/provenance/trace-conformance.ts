/** Compatibility surface for existing client imports. */
import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import {
  inspectFileTraceNucleus as inspectProtocolFileTraceNucleus,
  verifyFileTraceChain as verifyProtocolFileTraceChain,
  verifyFolderTraceChain as verifyProtocolFolderTraceChain,
  type FileTraceInspection as ProtocolFileTraceInspection,
  type TraceConformanceVerdict,
  type VerifyFileTraceOptions,
  type VerifyFolderTraceOptions,
} from "@zine/protocol";

export {
  combineTraceConformance,
  traceConformanceLabel,
} from "@zine/protocol";
export type {
  TraceConformanceIssue,
  TraceConformanceIssueKind,
  TraceConformanceStatus,
  TraceConformanceStep,
  TraceConformanceVerdict,
  VerifyFileTraceOptions,
  VerifyFolderTraceOptions,
} from "@zine/protocol";

export type TraceEventLoader = (nodeId: string) => Promise<Event | null>;

export type FileTraceInspection = Omit<ProtocolFileTraceInspection, "chain"> & {
  chain: Event[];
};

export function verifyFileTraceChain(
  chain: readonly Event[],
  options: VerifyFileTraceOptions = {},
): Promise<TraceConformanceVerdict> {
  return verifyProtocolFileTraceChain(chain, verifyEvent, options);
}

export function verifyFolderTraceChain(
  chain: readonly Event[],
  options: VerifyFolderTraceOptions = {},
): Promise<TraceConformanceVerdict> {
  return verifyProtocolFolderTraceChain(chain, verifyEvent, options);
}

export async function inspectFileTraceNucleus(
  nucleus: Event,
  loadEvent: TraceEventLoader,
  options: Omit<VerifyFileTraceOptions, "historyComplete"> = {},
): Promise<FileTraceInspection> {
  return await inspectProtocolFileTraceNucleus(
    nucleus,
    loadEvent,
    verifyEvent,
    options,
  ) as FileTraceInspection;
}
