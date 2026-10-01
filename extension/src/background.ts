// MV3 service worker: resilient image fetch + server bridge + context menu.
import { buildRefererRule, allocRuleId, releaseRuleId } from "./referer";
import { loadSettings } from "./settings";
import type { SourceLang, TranslateOptions, TranslateResponse } from "./types";

interface TranslateRequest {
  type: "translate";
  url: string;
  pageUrl: string;
  prevContext: string[];
}

const SERVER_TIMEOUT_MS = 120_000;

class StepError extends Error {
  constructor(
    message: string,
    readonly step: "fetch" | "server",
  ) {
    super(message);
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

async function fetchImage(url: string, pageUrl: string): Promise<Blob> {
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
  return job;
}

async function callServer(
  image: Blob,
  options: TranslateOptions,
): Promise<TranslateResponse> {
  const settings = await loadSettings();
  const form = new FormData();
  form.append("image", new Blob([image], { type: "image/jpeg" }), "page.jpg");
  form.append("options", JSON.stringify(options));

  const ac = new AbortController();
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
    if (ac.signal.aborted) throw new StepError("Dịch quá thời gian 120s — thử lại", "server");
    throw new StepError("Server local chưa chạy (python -m mt)", "server");
  }
  clearTimeout(timer);

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

chrome.runtime.onMessage.addListener((msg: TranslateRequest, _sender, sendResponse) => {
  if (msg.type !== "translate") return undefined;
  void (async () => {
    try {
      const settings = await loadSettings().catch(() => null);
      const image = await fetchImage(msg.url, msg.pageUrl);
      const options: TranslateOptions = {
        source_lang: (settings?.sourceLang ?? "auto") as SourceLang,
        target_lang: settings?.targetLang ?? "vi",
        prev_context: msg.prevContext,
      };
      const resp = await callServer(image, options);
      sendResponse(resp);
    } catch (err) {
      sendResponse({
        error: err instanceof Error ? err.message : String(err),
        step: err instanceof StepError ? err.step : "server",
      });
    }
  })();
  return true; // async response
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "mt-translate-image",
      title: "Dịch ảnh này",
      contexts: ["image"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "mt-translate-image" || !info.srcUrl || !tab?.id) return;
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
