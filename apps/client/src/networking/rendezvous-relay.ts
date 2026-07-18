import type { Event, Filter } from "nostr-tools";

import type { RelaySampleBounds, SampleHit } from "../provenance/provenance.js";

interface NativeRelaySampleRequest {
  operationId: string;
  url: string;
  filter: Filter;
  requestedIds?: readonly string[];
  timeoutMs: number;
  maxUniqueEvents: number;
  maxTotalBytes: number;
  maxEventBytes: number;
  maxContentLength: number;
  maxTags: number;
  maxTagValues: number;
  maxTagValueLength: number;
}

function aborted(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("operation aborted");
  error.name = "AbortError";
  return error;
}

async function withAbort<T>(
  start: () => Promise<T>,
  signal?: AbortSignal,
  cancelNative?: () => void,
): Promise<T> {
  if (!signal) return start();
  let dispatched = false;
  let cancellationSent = false;
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () => {
    if (dispatched && !cancellationSent) {
      cancellationSent = true;
      try {
        cancelNative?.();
      } catch {
        // Cancellation is best-effort; the caller must still stop waiting.
      }
    }
    rejectCancellation(aborted(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    signal.removeEventListener("abort", onAbort);
    throw aborted(signal);
  }
  try {
    // Arm cancellation before dispatch. A synchronous mock, bridge hook, or
    // abort fired while invoke() is constructing its Promise must still send
    // the exact operation id to the native pre-cancel path.
    dispatched = true;
    const promise = start();
    if (signal.aborted) onAbort();
    return await Promise.race([promise, cancellation]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Sample attacker-named relays through the native DNS-pinned connection path. */
export async function sampleRendezvousRelays(
  urls: string[],
  filter: Filter,
  perRelayMs: number,
  bounds: RelaySampleBounds,
): Promise<{ hits: SampleHit[]; errors: { url: string; error: string }[] }> {
  const { invoke } = await import("@tauri-apps/api/core");
  const errors: { url: string; error: string }[] = [];
  const byId = new Map<string, SampleHit>();
  await Promise.all(urls.map(async (url) => {
    const operationId = crypto.randomUUID();
    const request: NativeRelaySampleRequest = {
      operationId,
      url,
      filter,
      ...(bounds.requestedIds ? { requestedIds: bounds.requestedIds } : {}),
      timeoutMs: perRelayMs,
      maxUniqueEvents: bounds.maxUniqueEvents,
      maxTotalBytes: bounds.maxTotalBytes,
      maxEventBytes: bounds.maxEventBytes,
      maxContentLength: bounds.maxContentLength,
      maxTags: bounds.maxTags,
      maxTagValues: bounds.maxTagValues,
      maxTagValueLength: bounds.maxTagValueLength,
    };
    try {
      if (bounds.signal?.aborted) throw aborted(bounds.signal);
      const events = await withAbort(
        () => invoke<Event[]>("rendezvous_sample_relay", { request }),
        bounds.signal,
        () => {
          void invoke("rendezvous_cancel_relay_sample", { operationId })
            .catch(() => undefined);
        },
      );
      for (const event of events) {
        const existing = byId.get(event.id);
        if (existing) {
          if (!existing.relays.includes(url)) existing.relays.push(url);
        } else {
          byId.set(event.id, { event, relays: [url] });
        }
      }
    } catch (error) {
      errors.push({ url, error: error instanceof Error ? error.message : String(error) });
    }
  }));
  return { hits: [...byId.values()], errors };
}
