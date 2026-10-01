import { loadSettings, saveSettings } from "./settings";
import type { Settings } from "./settings";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const status = $<HTMLDivElement>("status");

function show(msg: string, ok: boolean): void {
  status.textContent = msg;
  status.className = ok ? "ok" : "err";
}

function formToSettings(s: Settings): Settings {
  return {
    ...s,
    serverUrl: $<HTMLInputElement>("serverUrl").value.replace(/\/+$/, ""),
    token: $<HTMLInputElement>("token").value,
    sourceLang: $<HTMLSelectElement>("sourceLang").value as Settings["sourceLang"],
  };
}

async function checkConnection(s: Settings): Promise<void> {
  const base = s.serverUrl.replace(/\/+$/, "");
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) {
      show("Server local chưa chạy", false);
      return;
    }
  } catch {
    show("Server local chưa chạy", false);
    return;
  }
  try {
    const auth = await fetch(`${base}/auth-check`, {
      headers: { "X-MT-Token": s.token },
      signal: AbortSignal.timeout(5000),
    });
    if (auth.ok) {
      show("Kết nối và token hợp lệ", true);
    } else if (auth.status === 401) {
      show("Server chạy nhưng token sai", false);
    } else {
      show("Server chạy nhưng trả về lỗi", false);
    }
  } catch {
    show("Server local chưa chạy", false);
  }
}

async function init(): Promise<void> {
  const s = await loadSettings();
  $<HTMLInputElement>("serverUrl").value = s.serverUrl;
  // Token is prefilled only into its own password field; never echoed elsewhere.
  $<HTMLInputElement>("token").value = s.token;
  $<HTMLSelectElement>("sourceLang").value = s.sourceLang;
  $<HTMLInputElement>("targetLang").value = s.targetLang;

  $<HTMLButtonElement>("check").addEventListener("click", () => {
    void checkConnection(formToSettings(s));
  });
  $<HTMLFormElement>("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = { ...s, ...formToSettings(s) };
    void saveSettings(next)
      .then(() => show("Đã lưu", true))
      .catch((err: unknown) => show(`Lưu thất bại: ${String(err)}`, false));
  });
}

void init();
