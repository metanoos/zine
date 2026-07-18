export interface DesktopOperationJournalSessionV1 {
  journalSessionId: string;
  journalGeneration: number;
}

let activeSession: Readonly<DesktopOperationJournalSessionV1> | null = null;

/** Capture the opaque capability returned by the native vault activation. */
export function captureDesktopOperationJournalSessionV1(
  value: unknown,
): Readonly<DesktopOperationJournalSessionV1> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native vault activation returned an invalid journal session");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== "journalSessionId" && key !== "journalGeneration",
    )
    || typeof record.journalSessionId !== "string"
    || !/^[0-9a-f]{64}$/.test(record.journalSessionId)
    || !Number.isSafeInteger(record.journalGeneration)
    || (record.journalGeneration as number) < 1
  ) {
    throw new Error("Native vault activation returned an invalid journal session");
  }
  activeSession = Object.freeze({
    journalSessionId: record.journalSessionId,
    journalGeneration: record.journalGeneration as number,
  });
  return activeSession;
}

export function clearDesktopOperationJournalSessionV1(): void {
  activeSession = null;
}

export function requireDesktopOperationJournalSessionV1(): Readonly<DesktopOperationJournalSessionV1> {
  if (!activeSession) {
    throw new Error("Unlock a vault before using its native operation journal");
  }
  return activeSession;
}
