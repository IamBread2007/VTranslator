// Batch identity and the unique-page accounting behind the consent gate and cap.
// Pure: no DOM, no chrome.*.

export interface BatchConfig {
  consentThreshold: number;
  maxPages: number;
}

export type DispatchReason = "ok" | "consent-required" | "cap-reached";

export interface DispatchDecision {
  proceed: boolean;
  reason: DispatchReason;
}

let fallbackCounter = 0;

export function newBatchId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  fallbackCounter += 1;
  return `b${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

/**
 * Decides whether one more page may be dispatched for a paid translation.
 *
 * `admit` is called immediately before each request, never at scan time. That is
 * the whole point: a reader can reveal pages the user never saw when they
 * confirmed, so a decision made during discovery could be stale by dispatch.
 *
 * Consent is headroom, not a permanent unlock. Granting it covers the pages the
 * dialog actually showed, so a lazy reader that later reveals more asks again
 * instead of quietly spending the user's money. The cap is absolute and is
 * checked first: consent can authorise work, it can never raise the ceiling.
 */
export class Batch {
  private currentId = newBatchId();
  private readonly admitted = new Set<string>();
  private grantedHeadroom = 0;

  constructor(private readonly config: BatchConfig) {}

  get id(): string {
    return this.currentId;
  }

  /** Distinct source pages dispatched, which is what the cap counts. */
  get accepted(): number {
    return this.admitted.size;
  }

  grantConsent(additional: number): void {
    if (additional > this.grantedHeadroom) this.grantedHeadroom = additional;
  }

  admit(url: string): DispatchDecision {
    // Already dispatched. A reader that remounts a page re-offers its URL, and
    // re-charging for it would be both wrong and surprising.
    if (this.admitted.has(url)) return { proceed: true, reason: "ok" };

    if (this.admitted.size >= this.config.maxPages) {
      return { proceed: false, reason: "cap-reached" };
    }

    if (
      this.admitted.size >= this.config.consentThreshold &&
      this.admitted.size >= this.config.consentThreshold + this.grantedHeadroom
    ) {
      return { proceed: false, reason: "consent-required" };
    }

    this.admitted.add(url);
    return { proceed: true, reason: "ok" };
  }

  /** New identity, cleared accounting, no inherited consent. */
  reset(): void {
    this.currentId = newBatchId();
    this.admitted.clear();
    this.grantedHeadroom = 0;
  }
}