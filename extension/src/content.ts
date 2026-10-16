// Content script: candidate discovery, single-file translate queue, image swap.
import {
  isMangaCandidate,
  isVisibleCandidate,
  resolveImageUrl,
  TranslateQueue,
} from "./discover";
import { pngBlob, renderPage } from "./render";
import { scan } from "./discovery";
import {
  applyStored as applyStoredPage,
  applyStoredIn,
  showOriginal,
  showTranslated,
  swapIn,
  togglePeek,
} from "./apply";
import { loadSettings } from "./settings";
import { TranslationStore, type StoreEntry } from "./store";
import { enqueuesWholeDocument, ignoredSubtrees, normalizeHost, normalizeMode, type ReaderMode } from "./sites";
import {
  STATE,
  APPLIED_BLOB,
  onSiteSourceSwap,
  takeOwnStyleWrites,
} from "./imgsrc";
import {
  badgeFor,
  collectCounts,
  emptyView,
  summarize,
  summarizeBatch,
  etaFor,
  promptBatchConsent,
  TTL_MS,
  type BatchView,
} from "./hudstate";
import { createHud } from "./hud";
import { EditLayer, OverlayLayer, blockAt, blockRect, type AnchorBox, type Size } from "./overlay";
import { Batch, newBatchId } from "./batch";
import { trackCoverage } from "./discovery";
import { DEFAULTS } from "./settings";
import type { Block, TranslateResponse } from "./types";

const MAX_CONTEXT = 20;
// How far past the viewport a page still counts as "on screen" for the default
// discovery pass. Only meaningful on `auto` sites — feeds and forums, where a
// wider window would swallow every image ever posted in the channel.
const VIEWPORT_PAD_PX = 1500;

const queue = new TranslateQueue();
const store = new TranslationStore();
const translations: string[] = []; // rolling context, completed pages only

/**
 * Reader layout of the current site. `auto` until the stored setting arrives, so
 * a trigger fired during startup uses the conservative viewport window rather
 * than guessing a reader it has not been told about.
 */
let readerMode: ReaderMode = "auto";

/** Batch limits, defaulted until the stored settings arrive. */
let limits = { consentThreshold: DEFAULTS.consentThreshold, maxPages: DEFAULTS.maxPages };

async function loadReaderMode(): Promise<void> {
  const s = await loadSettings().catch(() => null);
  if (!s) return;
  readerMode = normalizeMode(s.readerModes[normalizeHost(location.hostname)]);
  limits = { consentThreshold: s.consentThreshold, maxPages: s.maxPages };
}

void loadReaderMode();
// Changing the mode in Options must take effect without reloading the reader,
// which is exactly the tab the user is reading a chapter in.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.readerModes) void loadReaderMode();
});

/* ---------------- UI ---------------- */

const hud = createHud();
const layer = new OverlayLayer();

// Counts enqueues that really created work, so a trigger that discovered
// nothing can be told apart from a broken one.
let enqueues = 0;

/* ---------------- batch state ---------------- */

/**
 * Identity of the batch allowed to mutate the page right now.
 *
 * Empty means no batch is running. It is compared against the id captured when a
 * request was dispatched, which is what makes a late response harmless: a page
 * that finished after Stop, or after the user started a new batch, finds a
 * different id and is discarded before it can touch the DOM, the rolling
 * translation context, or the counters the HUD is showing.
 */
let activeBatchId = "";
let batch: Batch | null = null;
/** Non-empty while a solo (hover/retry/context) run owns the queue. */
let soloRunId = "";
let batchDurations: number[] = [];
let batchDone = 0;
let batchError = 0;
let capReached = false;
let batchStopReason: "capped" | "declined" | "user" | null = null;
/**
 * URL the batch was started on. MangaDex is an SPA: moving to another chapter does
 * not reload the page, so a live batch can outlive the chapter it was built for.
 * Comparing the URL is how enqueue() detects that and stops mixing chapters.
 */
let batchUrl = "";

/**
 * One pump per tab. Two loops would fight over the queue's single in-flight slot
 * and both increment the same counters.
 */
let pumping = false;

/**
 * True while the blocking consent dialog is open.
 *
 * The job being decided keeps the queue's in-flight slot the whole time, so any
 * other pump's `dequeue()` returns undefined and it exits without touching
 * anything. Rediscovery may still append behind it.
 */
let pausedForConsent = false;

/** Set while a discovery pass is still seeding the queue, to defer pumping. */
let seeding = false;

/** Thrown when a response arrives after its batch lost the right to apply. */
class StaleBatch extends Error {
  constructor() {
    super("batch no longer current");
    this.name = "StaleBatch";
  }
}

function currentCoverage() {
  return trackCoverage();
}

let coverage = currentCoverage();

/**
 * Stop the batch without discarding work already finished.
 *
 * Completed pages keep their translations and their store entries: the user
 * paid for them. Only the waiting queue is dropped, and only the in-flight page
 * is left for pump() to revert.
 */
function stopSolo(): void {
  const stoppingId = soloRunId;
  queue.clear();
  soloRunId = "";
  hud.setStop(false);
  syncHud();
  if (!stoppingId) return;
  try {
    void chrome.runtime.sendMessage({ type: "mt-stop", batchId: stoppingId });
  } catch {
    // The worker can already be asleep; the tab-side stop above still stands.
  }
}

function stopBatch(reason: "capped" | "declined" | "user"): void {
  batchStopReason = reason;
  queue.clear();
  soloRunId = "";
  hud.setStop(false);
  // Retiring the id is what invalidates any response still in flight.
  activeBatchId = "";
  batch = null;
  syncBatchHud();
}

// The stop control lives inside the status pill (hud.setStop) rather than as a
// separate fixed button: the two shared one corner and overlapped, and hover /
// retry / context entries never opened a batch, so they never showed a control.

/**
 * Stop the run and tell the worker to abandon the request in flight.
 *
 * The batch id is captured before `stopBatch` retires it: retiring is what makes
 * this tab ignore the late response, and the worker still needs the id to know
 * which upstream call to cancel.
 */
async function userStopBatch(): Promise<void> {
  // Alt+S during a solo hover run: no batch exists, but the solo id does.
  if (soloRunId && !batch) {
    stopSolo();
    return;
  }
  const stoppingId = activeBatchId;
  stopBatch("user");
  if (!stoppingId) return;
  try {
    await chrome.runtime.sendMessage({ type: "mt-stop", batchId: stoppingId });
  } catch {
    // The worker can already be asleep; the tab-side stop above still stands.
  }
}

/**
 * The pump loop drained: retire the batch and show the final summary.
 *
 * When the user already stopped the batch (`stopBatch` sets `batch = null`
 * earlier), this function is still reached at the end of pump's `while(true)`.
 * It must clear `batchStopReason` and flash the summary so the HUD does not
 * keep showing "đang dịch" forever.
 */
function finishBatch(): void {
  if (batch) {
    // Render first, while `batch` is still alive, so syncBatchHud takes the batch
    // branch: it shows the waiting view or the terminal tally, and never leaves the
    // last "running" view on screen.
    syncBatchHud();
    // Pages the reader has not laid out yet are still owed. Retiring now would drop
    // the consent envelope and the stop control while the chapter is partly done.
    if (batchDone + batchError < coverage.size()) return;
  }
  if (!batch) {
    // stopBatch() already nulled `batch` but left `batchStopReason` alive so
    // syncBatchHud could show "stopped" state while pump was still draining.
    // Now that pump has drained, flash the final summary THEN retire the reason.
    if (batchStopReason) {
      // A stopped batch always routes to hud.flash(summarizeBatch(view)), so
      // this shows the stopped summary once, with no spinner.
      syncBatchHud();
      batchStopReason = null;
    }
    soloRunId = "";
    hud.setStop(false);
    return;
  }
  activeBatchId = "";
  batch = null;
  soloRunId = "";
  hud.setStop(false);
}

/**
 * Refresh the page HUD and this tab's toolbar badge after any state change.
 * The badge is pushed here rather than polled because a content script is the
 * only place that sees both the DOM states and the queue's in-flight work.
 */
function syncHud(): void {
  // A running batch speaks through its own projection: the DOM-counting summary
  // cannot see pages that were discovered but never mounted, never dispatched, or
  // refused by the cap.
  if (batch || batchStopReason) {
    syncBatchHud();
    return;
  }
  // queue.size counts jobs whose image carries no data-mt-state yet (pump writes
  // that attribute only on dispatch), which is what makes the fraction show the
  // whole batch instead of a denominator that shrinks as work starts.
  const c = collectCounts(document, queue.size > 0 || queue.inFlight, queue.size);
  // The service worker may not exist yet when a page loads, or may have just
  // been reloaded with the extension; the badge is optional UI garnish, so a
  // dead endpoint must not break the HUD path. Reported at debug level only —
  // a missing service worker on page load is expected, not an incident.
  void chrome.runtime
    .sendMessage({ type: "mt-progress", badge: badgeFor(c) })
    .catch((err: unknown) => {
      console.debug("mt: toolbar badge update skipped:", err);
    });
  if (c.running) {
    hud.update(c);
    return;
  }
  if (c.error > 0) {
    hud.update(c);
    return;
  }
  if (c.done > 0) {
    hud.flash(summarize(c), TTL_MS.done);
    return;
  }
  hud.update(c); // idle → hide the pill, no residue on an untouched page
}

/**
 * Render batch progress.
 *
 * The ETA is derived from completed page durations only, and the denominator is
 * what discovery has actually seen — `summarizeBatch` words it as "trang đã thấy"
 * unless coverage is verified complete, so a lazy reader can never be told a
 * partial run translated the whole chapter.
 */
function syncBatchHud(): void {
  if (!batch && !batchStopReason) return;
  const discovered = coverage.size();
  const view: BatchView = {
    discovered,
    done: batchDone,
    error: batchError,
    queued: queue.size,
    capReached,
    coverage: coverage.state(),
    eta: etaFor(batchDone, discovered, batchDurations),
    stopped: batchStopReason ?? undefined,
  };
  // A stopped batch never renders as running. The pump may still drain an in-flight
  // page, but a spinner would promise work that will not be attempted, so the
  // stopped summary is flashed once and then hides.
  if (batchStopReason) {
    hud.flash(summarizeBatch(view), TTL_MS.done);
    return;
  }
  // "Running" requires real work. `discovered` exceeding what the queue holds is
  // the normal state on a paged reader (unmounted pages were counted by coverage),
  // so a settled-vs-discovered gap alone must not spin the pill.
  if (queue.size > 0 || queue.inFlight) {
    hud.updateBatch(view);
    return;
  }
  // Nothing in flight but pages remain undone: the reader has not mounted them yet.
  // Flash the waiting view rather than a terminal tally, so the user does not read
  // a partial chapter as finished; the batch itself stays alive for the next page.
  if (batchDone + batchError < discovered) {
    hud.flash(summarizeBatch({ ...view, waiting: true }), TTL_MS.done);
    return;
  }
  hud.flash(summarizeBatch(view), TTL_MS.done);
}

// One singleton node: the overlay layer anchors one node to one image, so the
// previous anchor must be cleared before the button can follow the cursor.
const hoverBtn = document.createElement("button");
hoverBtn.type = "button";
hoverBtn.textContent = "Dịch";
// Position/z-index come from OverlayLayer.styleFor, not here.
hoverBtn.style.cssText =
  "padding:4px 10px;font:13px sans-serif;background:#1b2a4a;color:#fff;" +
  "border:0;border-radius:4px;cursor:pointer;opacity:.92";

let hoverAnchor: Element | null = null;

function clearHover(): void {
  if (!hoverAnchor) return;
  layer.clear(hoverAnchor);
  hoverAnchor = null;
}

function showHover(el: Element): void {
  if (el.getAttribute(STATE)) return; // a settled or in-flight image speaks through its own chip/ring
  if (hoverAnchor === el) return;
  clearHover();
  hoverAnchor = el;
  layer.set(el, hoverBtn);
}

hoverBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const el = hoverAnchor;
  clearHover(); // the button must not linger over the image the user just clicked
  if (el instanceof Element) enqueue(el, { priority: true });
});

// Per-image pending rings: a fresh node per image so several images can show
// "being worked on" at once instead of one shared indicator.
const rings = new Map<Element, HTMLElement>();

function showRing(el: Element): void {
  // The ring takes the slot the hover button may be holding on this image.
  if (hoverAnchor === el) clearHover();
  let node = rings.get(el);
  if (!node) {
    node = document.createElement("div");
    node.className = "mt-ring";
    rings.set(el, node);
  }
  layer.cover(el, node);
}

function dropRing(el: Element): void {
  if (!rings.delete(el)) return;
  layer.clear(el);
}

function flashDone(el: Element): void {
  const chip = document.createElement("span");
  chip.textContent = "✓";
  // hud.ts only styles whole pills (`.mt-hud--ok` alone has no text colour, no
  // padding and no radius), so the per-image tick carries its own minimal look
  // instead of inheriting a pill rule it was never meant for.
  chip.style.cssText =
    "background:#0b6b32;color:#fff;border-radius:4px;padding:2px 6px;font:12px/1.2 sans-serif";
  layer.flashChip(el, chip, TTL_MS.chip);
}

// Error chips: one node per image, kept until the user retries — unlike the
// done tick, an error must not vanish while nobody has looked at it.
const errorChips = new Map<Element, HTMLElement>();

function showErrorChip(el: Element): void {
  dropErrorChip(el); // never stack a second chip on an already-flagged image
  const chip = document.createElement("span");
  chip.textContent = "Lỗi — bấm để thử lại";
  chip.style.cssText =
    "background:#b3261e;color:#fff;cursor:pointer;border-radius:4px;padding:2px 6px;font:12px/1.2 sans-serif";
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.removeAttribute(STATE);
    dropErrorChip(el);
    enqueue(el, { priority: true });
  });
  errorChips.set(el, chip);
  layer.set(el, chip);
}

function dropErrorChip(el: Element): void {
  if (!errorChips.delete(el)) return;
  layer.clear(el);
}

/** Drop every anchor we own for an image, e.g. one the page just removed. */
function dropAnchors(el: Element): void {
  rings.delete(el);
  errorChips.delete(el);
  if (hoverAnchor === el) hoverAnchor = null;
  layer.clear(el);
}

document.addEventListener(
  "mouseover",
  (e) => {
    // The event target on background-carried readers is the page div itself,
    // so the img instanceof check cannot be the gate here.
    const el = e.target;
    if (el instanceof Element && isMangaCandidate(el)) showHover(el);
  },
  true,
);
document.addEventListener(
  "focusin",
  (e) => {
    const el = e.target;
    if (el instanceof Element && isMangaCandidate(el)) {
      el.setAttribute("tabindex", "0");
      showHover(el);
    }
  },
  true,
);
document.addEventListener("mouseout", (e) => {
  // Entering the singleton button counts as leaving the image (the button is
  // anchored as a sibling, not a child), so without this guard the button would
  // be destroyed the moment the cursor reaches it and could never be clicked.
  if (e.relatedTarget instanceof Node && hoverBtn.contains(e.relatedTarget)) return;
  // Moving within a hovered element (e.g. into a child of a background page
  // div) must not dismiss the button either.
  if (e.relatedTarget instanceof Node && hoverAnchor?.contains(e.relatedTarget)) return;
  if (e.target === hoverBtn || e.target === hoverAnchor || e.target instanceof HTMLImageElement) {
    clearHover();
  }
});

/* ---------------- original view (hold click / Alt+O) ---------------- */

let holdTimer: number | undefined;
// Holding on one image peeks that image after a moment, so following a single
// page's art does not need the whole page swapped. Alt+O is the page-wide hold.
document.addEventListener("mousedown", (e) => {
  const el = e.target;
  if (el instanceof Element && el.getAttribute(STATE) === "done") {
    holdTimer = window.setTimeout(() => showOriginal(el), 400);
  }
});
document.addEventListener("mouseup", (e) => {
  window.clearTimeout(holdTimer);
  const el = e.target;
  if (el instanceof Element) showTranslated(el);
});
// Alt+O peeks every translated page at once: on a webtoon the single-image
// gesture only ever shows one panel of a chapter. Keydown repeats are no-ops
// because the swap is idempotent until the key comes back up.
document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "o" && e.key !== "O")) return;
  e.preventDefault();
  togglePeek(true);
});
document.addEventListener("keyup", (e) => {
  if (e.key !== "o" && e.key !== "O") return;
  togglePeek(false);
});

/* ---------------- in-place edit (Alt+E) ---------------- */

const edits = new EditLayer();
let editMode = false;

function setEditMode(on: boolean): void {
  editMode = on;
  hud.setEdit(on, setEditMode);
  if (!on) edits.close();
  hud.flash(
    on
      ? { kind: "done", tone: "ok", text: "Chế độ sửa — bấm vào vùng thoại để sửa chữ" }
      : { kind: "done", tone: "neutral", text: "Đã tắt chế độ sửa" },
    TTL_MS.done,
  );
}

document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "e" && e.key !== "E")) return;
  e.preventDefault();
  setEditMode(!editMode);
});

/**
 * Open an editor for the dialogue region under a click.
 *
 * Runs on the capture phase so the reader's own click-to-page handler does not
 * win the event: an edit click on a translated page must edit, not turn the
 * page. Only translated pages whose heavy detail is still stored can be edited
 * — past the detail cap the page renders from the object URL alone.
 */
document.addEventListener(
  "click",
  (e) => {
    if (edits.owns(e.target)) {
      e.stopPropagation();
      return;
    }
    if (!editMode || edits.isOpen) return;
    const target = e.target instanceof Element ? e.target.closest(`[${STATE}="done"]`) : null;
    if (!target) return;
    const applied = target.getAttribute(APPLIED_BLOB);
    const hit = applied ? store.find(applied) : undefined;
    const entry = hit ? store.getEntry(hit.url) : undefined;
    if (!hit || !entry) return;
    const view = boxOf(target.getBoundingClientRect());
    const known = pageSizeOf(target);
    if (known) {
      const block = blockAt(view, known, entry.blocks ?? [], e.clientX, e.clientY);
      if (!block) return;
      e.preventDefault();
      e.stopPropagation();
      openEditor(hit.url, target, entry, view, known, block);
      return;
    }
    // A background-carried page has no intrinsic size, so its page dimensions
    // are only known after the stored bitmap decodes; the click's default action
    // is left alone on this rare path.
    void openEditorAfterDecode(hit.url, target, entry, view, e);
  },
  true,
);

function boxOf(rect: DOMRect): AnchorBox {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

/** Page-pixel size of an element showing a translated page, when known synchronously. */
function pageSizeOf(el: Element): Size | null {
  if (el instanceof HTMLImageElement && el.naturalWidth > 0 && el.naturalHeight > 0) {
    return { w: el.naturalWidth, h: el.naturalHeight };
  }
  return null;
}

async function openEditorAfterDecode(
  url: string,
  target: Element,
  entry: StoreEntry,
  view: AnchorBox,
  e: MouseEvent,
): Promise<void> {
  const page = await bitmapSize(entry.inpaintedBlob);
  if (!page || edits.isOpen) return;
  const block = blockAt(view, page, entry.blocks ?? [], e.clientX, e.clientY);
  if (block) openEditor(url, target, entry, view, page, block);
}

async function bitmapSize(blob: Blob | undefined): Promise<Size | null> {
  if (!blob) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return size;
  } catch (err) {
    // The stored bitmap is the edit's canvas; without it there is nothing to
    // re-render onto, and the page is left as it is.
    console.warn("MT: cannot read stored page bitmap for editing:", err);
    return null;
  }
}

function openEditor(
  url: string,
  target: Element,
  entry: StoreEntry,
  view: AnchorBox,
  page: Size,
  block: Block,
): void {
  edits.open({
    rect: blockRect(view, page, block.box),
    value: block.translation,
    onCommit: (text) => void applyEdit(url, target, entry, block, text),
  });
}

/**
 * Re-render the page with one block's text replaced. Local only: the stored
 * inpainted bitmap and blocks are what the server already returned, so an edit
 * costs no request and no perception pass.
 */
async function applyEdit(
  url: string,
  target: Element,
  entry: StoreEntry,
  block: Block,
  text: string,
): Promise<void> {
  if (!entry.inpaintedBlob || !entry.blocks) return;
  const next = text.trim();
  // No-op edits skip the render entirely; an emptied box is a real edit that
  // erases the block, so only "unchanged" returns early.
  if (next === block.translation) return;
  const blocks = entry.blocks.map((b) => (b.id === block.id ? { ...b, translation: next } : b));
  const blob = await renderPage(entry.inpaintedBlob, blocks, {
    onOverflow: (id, minPx) => console.warn(`MT: block ${id} overflow at ${minPx}px`),
  });
  const objectUrl = URL.createObjectURL(blob);
  swapIn(target, url, objectUrl);
  if (target instanceof HTMLImageElement) target.setAttribute("src", objectUrl);
  // The store keeps owning the replaced blob's lifetime, and holds the edited
  // blocks so a later edit starts from this text.
  store.set(url, objectUrl, { inpaintedBlob: entry.inpaintedBlob, blocks });
}

/* ---------------- queue + dispatch ---------------- */

/**
 * Solo run (hover/retry/context) owns the queue without batch accounting: one
 * explicitly clicked page needs no consent dialog or page cap, so admitting it
 * through Batch would burn the free quota for no benefit. The id exists only
 * so the stop control can target the in-flight request.
 */
function ensureSolo(): void {
  if (batch || soloRunId) return;
  soloRunId = newBatchId();
  hud.setStop(true, () => stopSolo());
}

function enqueue(el: Element, opts: { priority?: boolean } = {}): void {
  // Runs before anything else so a stale batch never admits a page from the new
  // chapter. Retired silently: the old chapter's tally would describe pages the user
  // is no longer reading.
  if (batch && location.href !== batchUrl) {
    batch = null;
    activeBatchId = "";
    batchUrl = "";
    queue.clear();
    hud.setStop(false);
    // Idle counts are what hides the pill; a stale batch tally must not linger.
    hud.update({ total: 0, done: 0, error: 0, running: false });
  }
  if (el.getAttribute(STATE) === "pending" || el.getAttribute(STATE) === "done") return;
  if (!isMangaCandidate(el) || !isVisibleCandidate(el)) return;
  // A page the store already holds is not work: the blob goes straight back on.
  // On a paged reader this is the difference between returning to page 3 and
  // paying the full perception + LLM cost for a translation that still exists.
  if (applyStored(el)) {
    flashDone(el);
    syncHud();
    return;
  }
  const queuedBefore = queue.size;
  queue.enqueue(el, opts);
  // TranslateQueue silently drops duplicates and images with no resolvable URL,
  // so only a size change means this call actually created work.
  if (queue.size === queuedBefore) return;
  enqueues++;
  // While a discovery pass is still seeding, one pump at the end covers the
  // whole batch; pumping per page would open a second loop behind the consent
  // dialog for no reason.
  // Solo identity first: pump reads it at dispatch, and pump runs
  // synchronously up to its first await, so creating it after would miss.
  if (!batch) ensureSolo();
  if (!seeding) void pump();
  syncHud();
}

/**
 * Re-apply a page this tab has already translated, without a server round trip.
 * Thin wrapper so the store reaches the mutation paths without every call site
 * having to pass it along.
 */
function applyStored(el: Element): boolean {
  return applyStoredPage(el, store);
}

/**
 * Ask the user to authorise `count` more pages, and record the answer.
 *
 * Returns false when the user declined or the cap makes the work impossible
 * either way, which the caller treats as "stop, keeping finished work".
 */
async function confirmMore(count: number): Promise<boolean> {
  if (!batch) return false;
  const ok = await hud.prompt(promptBatchConsent(count, limits.maxPages));
  if (!ok) {
    stopBatch("declined");
    return false;
  }
  batch.grantConsent(Math.max(1, count - batch.approvedLimit));
  return true;
}

async function pump(): Promise<void> {
  // One pump per tab. A second loop would race this one over the queue's single
  // in-flight slot and over the batch counters.
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const el = queue.dequeue();
      if (!el) break;
      const url = resolveImageUrl(el);

      // Consent and the cap are enforced immediately before each paid request,
      // not at discovery time, because a reader can reveal pages the user never
      // saw when they confirmed.
      if (batch && url) {
        const decision = batch.admit(url);
        if (!decision.proceed) {
          if (decision.reason === "cap-reached") {
            queue.settle();
            capReached = true;
            stopBatch("capped");
            return;
          }
          // The job stays in the queue's in-flight slot for the whole dialog.
          // Settling it and re-queueing would let a rediscovery pass reorder the
          // queue underneath the answer, and would leave the page in a state no
          // path owns. Holding the slot also means any other pump's dequeue()
          // returns undefined and exits immediately.
          pausedForConsent = true;
          syncHud();
          const approved = await confirmMore(batch.accepted + 1);
          pausedForConsent = false;
          if (!approved) {
            queue.settle(); // nothing was dispatched for this element
            return;
          }
          // The reader may have unmounted or replaced the page while the dialog
          // was open; translating a detached node would waste a paid request.
          if (!el.isConnected || el.getAttribute(STATE) === "done") {
            queue.settle();
            continue;
          }
          // The grant may have been absorbed by the cap instead.
          if (!batch.admit(url).proceed) {
            queue.settle();
            capReached = true;
            stopBatch("capped");
            return;
          }
          // Same element, same slot, same position: fall through and dispatch.
        }
      }

      el.setAttribute(STATE, "pending");
      showRing(el);
      const startedAt = performance.now();
      try {
        await translateOne(el, batch ? activeBatchId : soloRunId);
        batchDurations.push(performance.now() - startedAt);
        batchDone++;
        el.setAttribute(STATE, "done");
        dropRing(el);
        flashDone(el);
      } catch (err) {
        if (err instanceof StaleBatch) {
          // This page belonged to a run that has since been stopped or replaced.
          // It is neither a success nor a failure: no state is written, so the
          // page reads exactly as it did before the request, and nothing is added
          // to the rolling translation context.
          el.removeAttribute(STATE);
          dropRing(el);
          syncBatchHud();
        } else {
          batchError++;
          el.setAttribute(STATE, "error");
          dropRing(el);
          showErrorChip(el);
          console.error("MT translate failed:", err);
        }
      } finally {
        queue.settle();
        syncHud();
      }
    }
    // The queue drained on its own. Settle the batch so a later trigger is not
    // swallowed by a finished run, and leave the summary on screen.
    finishBatch();
  } finally {
    pumping = false;
    pausedForConsent = false;
  }
}

async function translateOne(el: Element, batchId: string): Promise<void> {
  const url = resolveImageUrl(el);
  if (!url) throw new Error("no image URL");
  // prevContext is read NOW, immediately before dispatch, so page N+1 always
  // carries page N's lines when both sit in the same queue.
  const prevContext = translations.slice(-MAX_CONTEXT);
  const resp = (await chrome.runtime.sendMessage({
    type: "translate",
    url,
    pageUrl: location.href,
    prevContext,
    // Carried so the worker's Stop gate can target this exact run; without it
    // the worker cannot tell this request apart from another tab's batch.
    batchId,
  })) as TranslateResponse | { error: string };

  // The guard sits at the first await boundary and before anything observable:
  // a response that outlived its batch must not swap an image, must not publish
  // a blob into the store, and above all must not push into `translations`,
  // where it would become the prevContext of a page the user never stopped.
  if (batchId !== activeBatchId && batchId !== soloRunId) throw new StaleBatch();
  if ("error" in resp) throw new Error(resp.error);

  // One decode of the response PNG feeds both the first render and the stored
  // copy an in-place edit re-renders from; the server already sent the blocks.
  const inpainted = pngBlob(resp.inpainted_png);
  const blob = await renderPage(inpainted, resp.blocks, {
    onOverflow: (id, minPx) => console.warn(`MT: block ${id} overflow at ${minPx}px`),
  });
  const objectUrl = URL.createObjectURL(blob);

  swapIn(el, url, objectUrl);
  // The store takes over the blob's lifetime. The element attribute above is
  // only bookkeeping for show-original; releasing here on unmount would throw
  // away a page the user is about to come back to. The detail half is dropped
  // once the page falls behind the store's small edit-history window.
  store.set(url, objectUrl, { inpaintedBlob: inpainted, blocks: resp.blocks });
  if (el instanceof HTMLImageElement) el.setAttribute("src", objectUrl);

  for (const block of resp.blocks) translations.push(block.translation);
  while (translations.length > MAX_CONTEXT) translations.shift();
}

/* ---------------- observation ---------------- */

// Nothing is translated on its own initiative: images reach the queue only
// through an explicit user action (hover button, Alt+T, context menu, retry),
// and each of those paths re-queries the live DOM at trigger time, so newly
// inserted images need no pre-scanning.

// Fallback when the browser command is unavailable (e.g. key taken);
// the registered command path forwards from background.ts instead.
document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "t" && e.key !== "T")) return;
  triggerNearby();
});

/**
 * Forget an element we no longer control.
 *
 * The blob is deliberately NOT released: it is owned by the store, keyed by the
 * page URL, and a paged reader unmounting a page is exactly the case where the
 * user will want it back.
 */
function detachEl(el: Element): void {
  el.removeAttribute(APPLIED_BLOB);
}

const mo = new MutationObserver((records) => {
  // Snapshot taken before inspection: our own style writes were recorded
  // synchronously and must be told apart from a site swap in this batch.
  const ownWrites = takeOwnStyleWrites();
  for (const rec of records) {
    if (rec.type === "attributes") {
      const el = rec.target;
      if (!(el instanceof Element)) continue;
      if (el instanceof HTMLElement && !(el instanceof HTMLImageElement) && rec.attributeName === "style") {
        if (ownWrites.has(el)) continue; // our swap/show-original, not a site change
        // The site replaced a background it no longer wants translated. Same
        // rule as the img path: clear bookkeeping, never re-queue.
        if (onSiteSourceSwap(el, detachEl)) dropErrorChip(el);
        continue;
      }
      if (!(el instanceof HTMLImageElement)) continue;
      const next = el.getAttribute(rec.attributeName ?? "src") ?? "";
      // Our own swap produces blob: URLs; ignore it to avoid feedback loops.
      if (next.startsWith("blob:")) continue;
      // A reader that reuses one node and reassigns src for every page: the node
      // that just became page 3 may already be translated from an earlier visit.
      if (applyStored(el)) {
        flashDone(el);
        syncHud();
        continue;
      }
      // Stale translation bookkeeping is cleared, never re-queued: only an
      // explicit user action may start another translate.
      if (onSiteSourceSwap(el, detachEl)) dropErrorChip(el); // the retry offer pointed at state that no longer exists
    } else if (rec.type === "childList") {
      for (const node of rec.addedNodes) {
        for (const applied of applyStoredIn(node, store)) flashDone(applied);
      }
      // A book-style reader mounts the next page on navigation and never emits a
      // scroll event, so this observer is the only thing that notices. Guarded
      // on an active batch so an idle page pays nothing for it.
      if (batch) {
        for (const node of rec.addedNodes) {
          if (!(node instanceof Element)) continue;
          for (const el of scan(node, {
            wholeDocument: enqueuesWholeDocument(readerMode),
            padPx: VIEWPORT_PAD_PX,
            ignoredSubtrees: ignoredSubtrees(location.hostname),
          })) {
            const url = resolveImageUrl(el);
            if (url) coverage.accept(url);
            enqueue(el);
          }
        }
      }
      for (const node of rec.removedNodes) {
        if (!(node instanceof Element)) continue;
        detachEl(node);
        queue.remove(node);
        dropAnchors(node);
      }
    }
  }
});
mo.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["src", "srcset", "style"],
  childList: true,
  subtree: true,
});

/**
 * Alt+T and its forwarded command share this wrapper so a discovery pass that
 * found no new work says so: a keypress with zero visible effect reads as a
 * broken shortcut, not as "nothing needed translating".
 *
 * The confirmation happens here, before the first page is queued and therefore
 * before the first paid request. A 33-page chapter prompts once, up front,
 * rather than discovering the cost ten pages in.
 */
/** Every distinct page URL currently mounted, in DOM order. */
function collectUnique(): Map<string, Element> {
  const unique = new Map<string, Element>();
  for (const el of scan(document, {
    wholeDocument: enqueuesWholeDocument(readerMode),
    padPx: VIEWPORT_PAD_PX,
    ignoredSubtrees: ignoredSubtrees(location.hostname),
  })) {
    const url = resolveImageUrl(el);
    if (url) unique.set(url, el);
  }
  return unique;
}

async function triggerNearby(): Promise<void> {
  // Policy: a trigger arriving while a batch is running, or while its consent
  // dialog is open, is ignored rather than queued. Two batches in one tab would
  // share the single translate queue and the rolling translation context, and a
  // second pre-flight prompt would appear behind the first for no reason.
  if (batch || pausedForConsent || pumping) return;

  const unique = collectUnique();
  if (unique.size === 0) {
    hud.flash(emptyView(), TTL_MS.empty);
    return;
  }

  const next = new Batch(limits);
  if (next.needsConsent(unique.size)) {
    // Mark the tab busy before awaiting so a second Alt+T during the dialog is
    // ignored rather than opening a competing batch behind it.
    pausedForConsent = true;
    const ok = await hud.prompt(promptBatchConsent(unique.size, limits.maxPages));
    pausedForConsent = false;
    if (!ok) return; // nothing was dispatched and nothing was charged
    next.grantConsent(Math.max(1, unique.size - next.approvedLimit));

    // The reader may have mounted pages while the dialog was open, and the
    // rediscovery observer ignores them because no batch is running yet. Re-scan
    // so the approval applies to what exists now rather than to a snapshot taken
    // before the user was asked. Such pages were not in the dialog, so they fall
    // through to the dispatch-time safeguard and are confirmed separately.
    for (const [url, el] of collectUnique()) {
      if (!unique.has(url)) unique.set(url, el);
    }
  }

  batch = next;
  batchUrl = location.href;
  activeBatchId = next.id;
  batchDurations = [];
  batchDone = 0;
  batchError = 0;
  capReached = false;
  batchStopReason = null;
  coverage = currentCoverage();
  hud.setStop(true, () => void userStopBatch());

  const before = enqueues;
  seeding = true; // one pump at the end, not one per discovered page
  for (const [url, el] of unique) {
    coverage.accept(url);
    enqueue(el);
  }
  seeding = false;

  // A completed whole-document scan is a genuine traversal: every mounted page
  // was walked. Asserted from the scan, never from the queue draining — an empty
  // queue says nothing about whether the reader has more pages to mount, so it
  // must never be read as "whole chapter translated". `auto` keeps progressive
  // coverage because a viewport band is not a traversal.
  //
  // Must come after the accept() calls above: accepting a page is itself
  // evidence that discovery is still running, and it reopens coverage.
  if (enqueuesWholeDocument(readerMode)) coverage.finishTraversal();
  if (enqueues === before) {
    hud.flash(emptyView(), TTL_MS.empty);
    return;
  }
  void pump();
  syncHud();
}

/**
 * Re-scan while a batch is running.
 *
 * A reader that paginates mounts the next page's node on navigation and may
 * never emit a scroll event, so the existing MutationObserver covers that case
 * and this passive capture-phase listener covers the scroll case. Both only
 * observe: nothing here clicks, turns a page, or scrolls on the user's behalf.
 */
function onPossibleRediscovery(): void {
  if (!batch) return;
  for (const el of scan(document, {
    wholeDocument: enqueuesWholeDocument(readerMode),
    padPx: VIEWPORT_PAD_PX,
    ignoredSubtrees: ignoredSubtrees(location.hostname),
  })) {
    // Accept here as well as in the observer: a page found by scrolling is
    // translated like any other, and a page that is translated but not counted
    // breaks the tally (the done count can outrun the discovered total) and
    // lets a batch claim completion while it still has queued work.
    const url = resolveImageUrl(el);
    if (url) coverage.accept(url);
    enqueue(el);
  }
}
window.addEventListener("scroll", onPossibleRediscovery, { capture: true, passive: true });

/** Every image in the error state, re-queued through the normal enqueue path. */
function retryErrors(): void {
  for (const el of document.querySelectorAll("[data-mt-state]")) {
    if (el.getAttribute(STATE) === "error") {
      el.removeAttribute(STATE);
      dropErrorChip(el); // the offer is redeemed now; the ring will take its slot
      enqueue(el);
    }
  }
}

hud.onRetry(retryErrors);

// The pill's hold-to-peek control is the mouse equivalent of the Alt+O hold:
// press to see the site's own art, release to put the translations back.
hud.setPeek((hold) => {
  togglePeek(hold);
});
hud.setEdit(false, setEditMode);

// Background-driven retry (e.g. token fixed in options while a page errored)
// and the context menu "Dịch ảnh này" command.
chrome.runtime.onMessage.addListener(
  (msg: { type?: string; url?: string }, _sender, sendResponse) => {
    if (msg.type === "mt-retry-errors") {
      retryErrors();
    } else if (msg.type === "mt-enqueue-nearby") {
      // Alt+T arrives here as a browser command forwarded from background;
      // everything goes through the same sequential queue.
      triggerNearby();
    } else if (msg.type === "mt-stop-batch") {
      // Alt+S. Stopping is idempotent and safe with no run in progress, because
      // a keypress should never depend on knowing whether a batch happens to be
      // active at that instant.
      void userStopBatch();
      sendResponse({ ok: true });
    } else if (msg.type === "mt-translate-url" && msg.url) {
      // Context menu: enqueue the clicked image in the same queue.
      for (const el of document.querySelectorAll("img, [data-mt-state]")) {
        const canonical = resolveImageUrl(el);
        const rawSrc = el instanceof HTMLImageElement ? el.src : null;
        if (canonical === msg.url || rawSrc === msg.url) {
          if (el.getAttribute(STATE) === "done" || el.getAttribute(STATE) === "pending") {
            sendResponse({ ok: false, reason: "already" });
            return undefined;
          }
          enqueue(el, { priority: true });
          sendResponse({ ok: true });
          return undefined;
        }
      }
      sendResponse({ ok: false, reason: "not found" });
    }
    return undefined;
  },
);

// One startup sync clears this tab's toolbar badge when a fresh page loads,
// before any user trigger has run — otherwise a badge from a previous page
// would outlive navigation.
syncHud();
