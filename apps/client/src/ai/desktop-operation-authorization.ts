import type { DesktopOperationEnvelopeV1 } from "./desktop-operation-envelope.js";

export function desktopOperationAttemptKeyV1(
  operationId: string,
  attemptId: string,
): string {
  return `${operationId}\0${attemptId}`;
}

export function desktopOperationRequiresCurrentSessionAuthorityV1(
  envelope: DesktopOperationEnvelopeV1,
): boolean {
  return envelope.prepared.traceAuthoring.authorityPersistence
      === "current-editor-session-only"
    && envelope.prepared.traceAuthoring.compiled.directives.length > 0;
}

export function isDesktopOperationAuthorizedThisSessionV1(
  envelope: DesktopOperationEnvelopeV1,
  authorizedAttemptKeys: ReadonlySet<string>,
): boolean {
  return !desktopOperationRequiresCurrentSessionAuthorityV1(envelope)
    || authorizedAttemptKeys.has(desktopOperationAttemptKeyV1(
      envelope.operationId,
      envelope.attempt.attemptId,
    ));
}

export function isDesktopOperationAuthorizationSatisfiedV1(
  envelope: DesktopOperationEnvelopeV1,
  isAuthorizedAttempt?: (envelope: DesktopOperationEnvelopeV1) => boolean,
): boolean {
  return !desktopOperationRequiresCurrentSessionAuthorityV1(envelope)
    || isAuthorizedAttempt?.(envelope) === true;
}
