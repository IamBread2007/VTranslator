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
 * Decides how many pages a batch may dispatch, and who has to agree to them.
 *
 * Two gates, with different jobs:
 *
 * `needsConsent(discovered)` is the blocking pre-flight check. It runs once,
 * against a full discovery pass, *before the first paid request* — so a chapter
 * of 33 pages prompts before page 1 rather than after ten pages have already
 * been paid for.
 *
 * `admit` is the dispatch-time safeguard that runs before every request. It
 * catches pages the reader revealed after the dialog was answered, and it is
 * not a substitute for the pre-flight prompt.
 *
 * Approval is expressed as an absolute limit on pages dispatched, starting at
 * the configured threshold and raised cumulatively by each confirmation. Raising
 * it cumulatively rather than keeping a running maximum is what lets a user
 * approve "five more" twice and get ten more.
 *
 * The cap is separate and absolute: confirmation can authorise work, it can
 * never raise the ceiling.
 */
export class Batch {
  private currentId = newBatchId();
  private readonly admitted = new Set<string>();
  private approvedPages: number;

  constructor(private readonly config: BatchConfig) {
    this.approvedPages = config.consentThreshold;
  }

  get id(): string {
    return this.currentId;
  }

  /** Distinct source pages dispatched, which is what the cap counts. */
  get accepted(): number {
    return this.admitted.size;
  }

  /** Pages this batch may dispatch before it must ask again. */
  get approvedLimit(): number {
    return this.approvedPages;
  }

  /**
   * Blocking check for the initial discovery pass. Strictly greater: a chapter
   * of exactly `consentThreshold` pages is small enough to just translate.
   */
  needsConsent(discovered: number): boolean {
    return discovered > this.approvedPages;
  }

  /**
   * Record the user's confirmation of `additional` pages. Cumulative, so
   * confirming the same size twice authorises twice as many; non-positive
   * values are ignored so a malformed caller cannot shrink an approval.
   */
  grantConsent(additional: number): void {
    if (additional > 0) this.approvedPages += additional;
  }

  admit(url: string): DispatchDecision {
    // Already dispatched. A reader that remounts a page re-offers its URL, and
    // re-charging for it would be both wrong and surprising.
    if (this.admitted.has(url)) return { proceed: true, reason: "ok" };

    if (this.admitted.size >= this.config.maxPages) {
      return { proceed: false, reason: "cap-reached" };
    }

    if (this.admitted.size >= this.approvedPages) {
      return { proceed: false, reason: "consent-required" };
    }

    this.admitted.add(url);
    return { proceed: true, reason: "ok" };
  }

  /** New identity, cleared accounting, approval back to the threshold. */
  reset(): void {
    this.currentId = newBatchId();
    this.admitted.clear();
    this.approvedPages = this.config.consentThreshold;
  }
}