// MV3 service worker: resilient image fetch + server bridge + context menu.
import { buildRefererRule, allocRuleId, releaseRuleId } from "./referer";
import { loadSettings } from "./settings";
import type { SourceLang, TranslateOptions, TranslateResponse } from "./types";

interface TranslateRequest {
  type: "translate";
  url: string;
  pageUrl: string;
  prevContext: string[];
  /** Identifies the run that requested this page, so Stop can target it. */
  batchId: string;
}

/**
 * Ask the worker to abandon an in-flight request.
 *
 * `tabId` is explicit because the stop may be raised from a context menu or a
 * command, where there is no `sender.tab`. When it is omitted the batch is
 * stopped in every tab, which is correct because batch ids are unique per run.
 */
interface StopRequest {
  type: "mt-stop";
  batchId: string;
  tabId?: number;
}

/**
 * The content script mirroring its counts onto this tab's toolbar badge.
 * `badge` is already the rendered text+color pair from hudstate.badgeFor, so
 * this worker never re-derives wording — one module owns the clamp and the
 * colors, the other only forwards them.
 */
interface ProgressRequest {
  type: "mt-progress";
  badge: { text: string; color: string };
}

type IncomingMessage = TranslateRequest | ProgressRequest | StopRequest;

type Step = "fetch" | "server" | "stopped";

const SERVER_TIMEOUT_MS = 120_000;

class StepError extends Error {
  constructor(
    message: string,
    readonly step: Step,
  ) {
    super(message);
  }
}

/**
 * The request was abandoned because the user pressed Stop, not because anything
 * failed. Reporting it as a server error would show a red "trang lỗi" count for
 * a page the user deliberately cancelled.
 */
class StoppedError extends StepError {
  constructor() {
    super("Đã dừng theo yêu cầu", "stopped");
  }
}

function isImageMime(type: string): boolean {
  return type.startsWith("image/") || type === "" || type === "application/octet-stream";
}

function extensionInitiatorDomain(): string | undefined {
  try {
    return new URL(chrome.runtime.getURL("manifest.json")).hostname;
  } catch {
    return undefined; // older runtimes with unusual extension URIs
  }
}

const fetchInFlight = new Map<string, Promise<Blob>>();

function rejectOnStop(stop: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (stop.aborted) {
      reject(new StoppedError());
      return;
    }
    stop.addEventListener("abort", () => reject(new StoppedError()), { once: true });
  });
}

async function fetchImage(
  url: string,
  pageUrl: string,
  stop?: AbortSignal,
): Promise<Blob> {
  const doFetch = async (): Promise<Blob> => {
    let resp = await fetch(url, { credentials: "include" });
    if (resp.status === 401 || resp.status === 403) {
      // Hotlink protection: replay once with the reader page as Referer.
      const id = allocRuleId();
      const rule = buildRefererRule(id, url, pageUrl, {
        initiatorDomain: extensionInitiatorDomain(),
      });
      try {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [id],
          addRules: [rule],
        });
        resp = await fetch(url, { credentials: "include" });
      } finally {
        await chrome.declarativeNetRequest
          .updateSessionRules({ removeRuleIds: [id] })
          .catch(() => undefined);
        releaseRuleId(id);
      }
    }
    if (!resp.ok) throw new StepError(`Không tải được ảnh (HTTP ${resp.status})`, "fetch");
    const blob = await resp.blob();
    if (!isImageMime(blob.type) || blob.size === 0) {
      // Do not forward an HTML error page or empty body to the server.
      throw new StepError("Ảnh tải về không hợp lệ (không phải image/png|jpeg)", "fetch");
    }
    return blob;
  };

  // Tabs translating the same URL share the network fetch only; translation
  // per-call context stays separate (ordering lives in the content script).
  const existing = fetchInFlight.get(url);
  const job = existing ?? doFetch();
  if (!existing) {
    fetchInFlight.set(url, job);
    void job.finally(() => fetchInFlight.delete(url));
  }
  // Racing rather than aborting is deliberate: the shared promise belongs to
  // every tab using that URL, so cancelling one tab's download would destroy a
  // result another tab is still waiting for. The stopped tab stops waiting.
  if (!stop) return job;
  return Promise.race([job, rejectOnStop(stop)]);
}

/**
 * Live requests, keyed by `${tabId}:${batchId}`.
 *
 * Stop is scoped to both halves because one tab can run a batch while another
 * runs a different one, and stopping "the" batch without a tab would take down
 * work the user did not ask to cancel.
 */
const inFlight = new Map<string, AbortController>();

function flightKey(tabId: number | undefined, batchId: string | undefined): string | null {
  if (tabId === undefined || !batchId) return null;
  return `${tabId}:${batchId}`;
}

/** Abort matching requests and forget them. Returns how many were cancelled. */
function abortBatch(batchId: string, tabId?: number): number {
  let cancelled = 0;
  for (const [key, ac] of [...inFlight]) {
    const [keyTab, keyBatch] = key.split(":");
    if (keyBatch !== batchId) continue;
    if (tabId !== undefined && Number(keyTab) !== tabId) continue;
    inFlight.delete(key);
    ac.abort();
    cancelled += 1;
  }
  return cancelled;
}

async function callServer(
  image: Blob,
  options: TranslateOptions,
  stop?: AbortSignal,
): Promise<TranslateResponse> {
  const settings = await loadSettings();
  const form = new FormData();
  form.append("image", new Blob([image], { type: "image/jpeg" }), "page.jpg");
  form.append("options", JSON.stringify(options));

  const ac = new AbortController();
  // The timeout and the user's Stop share one controller: whichever fires first
  // cancels the fetch, and the reason is read back below so the two are not
  // reported as the same failure.
  const onStop = () => ac.abort();
  stop?.addEventListener("abort", onStop, { once: true });
  const timer = setTimeout(() => ac.abort(), SERVER_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${settings.serverUrl.replace(/\/$/, "")}/translate`, {
      method: "POST",
      headers: { "X-MT-Token": settings.token },
      body: form,
      signal: ac.signal,
    });
  } catch {
    clearTimeout(timer);
    stop?.removeEventListener("abort", onStop);
    if (stop?.aborted) throw new StoppedError();
    if (ac.signal.aborted) throw new StepError("Đã hết thời gian 120s - thử lại", "server");
    throw new StepError("Server local chưa chạy (python -m mt)", "server");
  }
  clearTimeout(timer);
  stop?.removeEventListener("abort", onStop);

  if (resp.status === 401) throw new StepError("Sai token — kiểm tra trong Settings", "server");
  if (resp.status === 413) throw new StepError("Ảnh quá lớn", "server");
  if (!resp.ok) {
    const detail = await resp.json().catch(() => null);
    throw new StepError(
      (detail && typeof detail.detail === "string" && detail.detail) ||
        `Server lỗi (HTTP ${resp.status})`,
      "server",
    );
  }
  return (await resp.json()) as TranslateResponse;
}

chrome.runtime.onMessage.addListener((msg: IncomingMessage, sender, sendResponse) => {
  if (msg.type === "mt-progress") {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      void chrome.action.setBadgeText({ tabId, text: msg.badge.text });
      void chrome.action.setBadgeBackgroundColor({ tabId, color: msg.badge.color });
    }
    return undefined;
  }
  if (msg.type === "mt-stop") {
    // No tab means "this batch anywhere"; a batch id is unique per run, so that
    // is unambiguous even though it is broader than a tab-scoped stop.
    const cancelled = abortBatch(msg.batchId, msg.tabId ?? sender.tab?.id);
    sendResponse({ cancelled });
    return undefined;
  }
  if (msg.type !== "translate") return undefined;
  const key = flightKey(sender.tab?.id, msg.batchId);
  // One controller per tab+batch, reused across the pages of that run so a Stop
  // arriving between two pages still cancels the one that is about to start.
  const ac = key !== null ? (inFlight.get(key) ?? new AbortController()) : undefined;
  if (key !== null && ac !== undefined) inFlight.set(key, ac);
  void (async () => {
    try {
      const settings = await loadSettings().catch(() => null);
      const image = await fetchImage(msg.url, msg.pageUrl, ac?.signal);
      const options: TranslateOptions = {
        source_lang: (settings?.sourceLang ?? "auto") as SourceLang,
        target_lang: settings?.targetLang ?? "vi",
        prev_context: msg.prevContext,
      };
      const resp = await callServer(image, options, ac?.signal);
      sendResponse(resp);
    } catch (err) {
      sendResponse({
        error: err instanceof Error ? err.message : String(err),
        step: err instanceof StepError ? err.step : "server",
      });
    } finally {
      if (key !== null && inFlight.get(key) === ac) inFlight.delete(key);
    }
  })();
  return true; // async response
});

const MENU_ID = "mt-translate-image";

/**
 * Register the right-click entry, tolerating a menu that already exists.
 *
 * Service workers restart freely and `onInstalled` fires for install, update
 * and chrome_update, so this routinely runs against a profile that already has
 * the item: menus outlive the worker that created them. `removeAll` is
 * asynchronous, so a bare `create` can still land on a surviving id and fail
 * with "Cannot create item with duplicate id".
 *
 * The callback is not optional: an API call that sets `lastError` without
 * reading it is reported by Chrome as an unchecked runtime error, which is
 * noise the user cannot act on and which would otherwise hide real failures.
 */
function registerContextMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      { id: MENU_ID, title: "Dịch ảnh này", contexts: ["image"] },
      () => {
        const err = chrome.runtime.lastError;
        // A duplicate means the item is already present, which is the desired
        // end state: report it and move on rather than failing the listener.
        if (err) console.warn(`MT context menu: ${err.message}`);
      },
    );
  });
}

chrome.runtime.onInstalled.addListener(registerContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl || !tab?.id) return;
  // Enqueue in the content script; never bypass the sequential queue.
  chrome.tabs
    .sendMessage(tab.id, { type: "mt-translate-url", url: info.srcUrl })
    .catch(() => undefined);
});

// Alt+T is registered as a browser command, so the page never sees the
// keydown; forward it to the active tab instead.
chrome.commands.onCommand.addListener((command) => {
  if (command !== "translate-page") return;
  void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const id = tabs[0]?.id;
    if (id !== undefined) {
      void chrome.tabs.sendMessage(id, { type: "mt-enqueue-nearby" }).catch(() => undefined);
    }
  });
});
