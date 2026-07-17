export interface StepRelease<Signer, Meta> {
  signer: Signer | undefined;
  meta: Meta | undefined;
}

/** Collect per-path release state until every concurrent operation finishes. */
export class RefCountedStepGate<Signer, Meta> {
  private depth = 0;
  private releases = new Map<string, StepRelease<Signer, Meta>>();

  get suppressed(): boolean {
    return this.depth > 0;
  }

  begin(): void {
    this.depth++;
  }

  release(
    path?: string,
    signer?: Signer,
    meta?: Meta | null,
  ): Map<string, StepRelease<Signer, Meta>> | null {
    if (path) this.releases.set(path, { signer, meta: meta ?? undefined });
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth > 0) return null;

    const ready = new Map(this.releases);
    this.releases.clear();
    return ready;
  }
}
