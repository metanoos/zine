import type { Event, Filter } from "nostr-tools";

import type { RelaySampleBounds, SampleHit } from "../provenance/provenance.js";

interface NativeRelaySampleRequest {
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

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw aborted(signal);
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(aborted(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
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
    const request: NativeRelaySampleRequest = {
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
      const events = await withAbort(
        invoke<Event[]>("rendezvous_sample_relay", { request }),
        bounds.signal,
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
