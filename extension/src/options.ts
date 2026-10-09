import { loadSettings, saveSettings } from "./settings";
import type { Settings } from "./settings";
import {
  MODE_EXAMPLES,
  READER_MODES,
  normalizeHost,
  normalizeMode,
  type ReaderMode,
} from "./sites";

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const status = $<HTMLDivElement>("status");

/** What the user sees for each mode, rather than the internal slug. */
const MODE_LABELS: Record<ReaderMode, string> = {
  auto: "Tự động (chỉ ảnh gần màn hình)",
  "vertical-scroll": "Cuộn dọc — một cột dài",
  paged: "Lật trang — bấm sang trang sau",
  "horizontal-slide": "Lướt ngang — như lật sách",
};

/** Kept in module scope so the add-form edits the same record the list renders. */
let modes: Record<string, ReaderMode> = {};

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

function renderModes(): void {
  const list = $<HTMLUListElement>("modes");
  const hosts = Object.keys(modes).sort();
  list.replaceChildren(
    ...hosts.map((host) => {
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.className = "host";
      name.textContent = host;

      const select = document.createElement("select");
      for (const mode of READER_MODES) {
        const opt = document.createElement("option");
        opt.value = mode;
        opt.textContent = MODE_LABELS[mode];
        select.appendChild(opt);
      }
      select.value = modes[host];
      select.addEventListener("change", () => {
        modes[host] = normalizeMode(select.value);
        void persistModes("Đã lưu");
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Xoá";
      remove.addEventListener("click", () => {
        delete modes[host];
        renderModes();
        void persistModes("Đã lưu");
      });

      const examples = document.createElement("span");
      examples.className = "examples";
      examples.textContent = MODE_EXAMPLES[modes[host]].join(", ");

      li.append(name, select, remove, examples);
      return li;
    }),
  );
}

async function persistModes(msg: string): Promise<void> {
  const s = await loadSettings();
  try {
    await saveSettings({ ...s, readerModes: modes });
    show(msg, true);
  } catch (err) {
    show(`Lưu thất bại: ${String(err)}`, false);
  }
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

function initAddForm(): void {
  const select = $<HTMLSelectElement>("newMode");
  // `auto` is offered so a host can be listed explicitly, but it is the default
  // for everything and is dropped on save; the list only shows real choices.
  for (const mode of READER_MODES) {
    const opt = document.createElement("option");
    opt.value = mode;
    opt.textContent = MODE_LABELS[mode];
    select.appendChild(opt);
  }
  select.value = "paged";

  $<HTMLButtonElement>("addMode").addEventListener("click", () => {
    const host = normalizeHost($<HTMLInputElement>("newHost").value);
    if (!host) {
      show("Nhập tên trang trước", false);
      return;
    }
    modes[host] = normalizeMode(select.value);
    $<HTMLInputElement>("newHost").value = "";
    renderModes();
    void persistModes("Đã lưu");
  });

  $<HTMLButtonElement>("resetModes").addEventListener("click", () => {
    modes = {};
    renderModes();
    void persistModes("Đã lưu");
  });
}

async function init(): Promise<void> {
  const s = await loadSettings();
  $<HTMLInputElement>("serverUrl").value = s.serverUrl;
  // Token is prefilled only into its own password field; never echoed elsewhere.
  $<HTMLInputElement>("token").value = s.token;
  $<HTMLSelectElement>("sourceLang").value = s.sourceLang;
  $<HTMLInputElement>("targetLang").value = s.targetLang;
  modes = s.readerModes;
  renderModes();
  initAddForm();

  $<HTMLButtonElement>("check").addEventListener("click", () => {
    void checkConnection(formToSettings(s));
  });
  $<HTMLFormElement>("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = { ...s, ...formToSettings(s), readerModes: modes };
    void saveSettings(next)
      .then(() => show("Đã lưu", true))
      .catch((err: unknown) => show(`Lưu thất bại: ${String(err)}`, false));
  });
  $<HTMLFormElement>("modesForm").addEventListener("submit", (e) => e.preventDefault());
}

void init();