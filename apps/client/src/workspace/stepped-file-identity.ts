export interface ResolvePostWriteTraceIdInput {
  nodeId: string;
  priorTraceId: string | null;
  readPersistedTraceId: () => string | null | undefined;
  resolveTraceIdentity: (nodeId: string) => Promise<string | null>;
}

/**
 * Resolve stable identity after a completed write.
 *
 * A write can fork a foreign member, so pre-write FileState is only a last
 * resort: the durable backend record and the returned head both describe the
 * post-write chain. Keeping this priority in one helper prevents alternate
 * Step paths from advancing a head while retaining a foreign trace identity.
 */
export async function resolvePostWriteTraceId(
  input: ResolvePostWriteTraceIdInput,
): Promise<string | null> {
  const persisted = input.readPersistedTraceId();
  if (persisted) return persisted;
  try {
    const resolved = await input.resolveTraceIdentity(input.nodeId);
    if (resolved) return resolved;
  } catch {
    // The completed local write remains usable offline. Its previous identity
    // is safe only when neither post-write source can resolve a replacement.
  }
  return input.priorTraceId;
}
