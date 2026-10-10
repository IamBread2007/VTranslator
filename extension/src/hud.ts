// The page-level status pill. Pure DOM (no chrome.*): callers feed it Counts and
// it decides what the user sees, so a 12-25s cold translation still reads as
// "working" instead of "broken".

import { summarize, summarizeBatch, type BatchView, type Counts, type HudView } from "./hudstate";

export interface Hud {
  /** Idle counts hide the pill; anything else replaces its content. */
  update(c: Counts): void;
  /** Persistent batch projection; hides itself when there is nothing to say. */
  updateBatch(v: BatchView): void;
  /** Show a view for ttlMs then hide it, for one-shot results. */
  flash(view: HudView, ttlMs: number): void;
  /** Called when the user clicks the pill while it is showing an error. */
  onRetry(cb: () => void): void;
  /** Blocking confirmation. Resolves true only on an explicit accept. */
  prompt(view: HudView): Promise<boolean>;
  destroy(): void;
}

const Z_TOP = "2147483647";

// The pill's own text carries Vietnamese diacritics, so it leads with the
// project's Vietnamese-covering face (registered by render.ts as
// "MT Be Vietnam Pro") instead of a bare system stack, which on Windows falls
// back to a font that renders tone marks inconsistently. system-ui/sans-serif
// stay at the end of the list for the window before ensureFonts() resolves.
//
// Kept as a constant (not a build-time asset) because content scripts cannot
// reliably load an external stylesheet, and exporting it lets tests assert the
// reduced-motion and animation rules survive whichever injection path runs.
export const HUD_CSS = `
.mt-hud{position:fixed;display:none;align-items:center;gap:8px;z-index:${Z_TOP};max-width:45vw;padding:8px 12px;border-radius:999px;font:600 13px/1.35 "MT Be Vietnam Pro","Be Vietnam Pro",system-ui,sans-serif;color:#fff;background:#1b2a4a;box-shadow:0 2px 10px rgba(0,0,0,.35)}
.mt-hud--ok{background:#0b6b32}
.mt-hud--error{background:#b3261e;cursor:pointer}
.mt-hud--warn{background:#8a5300}
.mt-hud__label{white-space:pre-wrap}
.mt-spin{flex:0 0 auto;width:12px;height:12px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:mt-spin .8s linear infinite}
.mt-ring{border:3px solid #4f8cff;box-shadow:0 0 0 3px rgba(79,140,255,.35) inset;animation:mt-pulse 1.2s ease-in-out infinite}
@keyframes mt-spin{to{transform:rotate(360deg)}}
@keyframes mt-pulse{0%,100%{opacity:1}50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.mt-spin,.mt-ring{animation:none}}
.mt-dialog{position:fixed;inset:0;margin:auto;width:min(28rem,calc(100vw - 2rem));padding:1rem 1.25rem;border:0;border-radius:12px;background:#fff;color:#1b2a4a;box-shadow:0 12px 40px rgba(0,0,0,.35);font:600 14px/1.45 "MT Be Vietnam Pro","Be Vietnam Pro",system-ui,sans-serif}
.mt-dialog::backdrop{background:rgba(0,0,0,.45)}
.mt-dialog__text{margin:0 0 1rem;white-space:pre-wrap}
.mt-dialog__actions{display:flex;gap:0.5rem;justify-content:flex-end}
.mt-dialog button{font:inherit;padding:0.45rem 0.9rem;border-radius:8px;border:1px solid #c7cdd8;background:#f3f5f9;color:#1b2a4a;cursor:pointer}
.mt-dialog button[data-mt-accept]{background:#1b2a4a;color:#fff;border-color:#1b2a4a}
`;

// Content scripts share the page's CSP. Constructable stylesheets are the
// primary path because adopted sheets are not blocked by a page's style-src;
// the <style> tag is a fallback for engines without CSSStyleSheet() (and for
// jsdom in tests), where a tag is the only option.
const injected = new WeakSet<Document>();

function ensureCss(doc: Document): void {
  if (injected.has(doc)) return;
  injected.add(doc);

  if (typeof CSSStyleSheet === "function" && Array.isArray(doc.adoptedStyleSheets)) {
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(HUD_CSS);
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      return;
    } catch (err) {
      // A document that rejects an adopted sheet still needs the rules, so fall
      // through to the tag rather than leaving the pill unstyled.
      console.warn("mt-hud: adopted stylesheet rejected, using <style> tag:", err);
    }
  }

  if (doc.querySelector("style[data-mt-hud-css]")) return;
  const tag = doc.createElement("style");
  tag.setAttribute("data-mt-hud-css", "1");
  tag.textContent = HUD_CSS;
  (doc.head ?? doc.documentElement).appendChild(tag);
}

/** Spinner only while something is moving: a tick on a settled result would read as still-working. */
function wantsSpinner(kind: HudView["kind"]): boolean {
  return kind === "running" || kind === "empty";
}

export function createHud(): Hud {
  const doc = document;
  const win = doc.defaultView ?? window;
  ensureCss(doc);

  const pill = doc.createElement("div");
  pill.setAttribute("data-mt-hud", "1");
  pill.setAttribute("role", "status");
  pill.setAttribute("aria-live", "polite");
  pill.setAttribute("aria-atomic", "true");
  pill.style.position = "fixed";
  pill.style.right = "16px";
  pill.style.bottom = "16px";
  pill.style.zIndex = Z_TOP;
  pill.style.display = "none";
  doc.body.appendChild(pill);

  const label = doc.createElement("span");
  label.className = "mt-hud__label";
  const spinner = doc.createElement("span");
  spinner.className = "mt-spin";
  spinner.setAttribute("aria-hidden", "true");

  let kind: HudView["kind"] = "idle";
  let hideTimer: number | undefined;
  let retry: (() => void) | undefined;

  function show(view: HudView): void {
    cancelHide();
    kind = view.kind;
    label.textContent = view.text;
    pill.className = `mt-hud mt-hud--${view.tone}`;
    pill.setAttribute("data-tone", view.tone);
    pill.setAttribute("data-kind", view.kind);
    pill.replaceChildren(...(wantsSpinner(view.kind) ? [spinner, label] : [label]));
    pill.style.display = "flex";
  }

  function hide(): void {
    kind = "idle";
    pill.setAttribute("data-kind", "idle");
    pill.style.display = "none";
  }

  function cancelHide(): void {
    if (hideTimer !== undefined) {
      win.clearTimeout(hideTimer);
      hideTimer = undefined;
    }
  }

  // A click on a settled "done" or a running batch must not look like a retry to
  // the user, so the handler is gated on the state that actually offers one.
  pill.addEventListener("click", () => {
    if (kind !== "error") return;
    retry?.();
  });

  return {
    update(c: Counts): void {
      // Cancel first, on the idle path too: a flash timer left running would hide
      // a state that was set after it, and an idle state must not depend on it.
      cancelHide();
      const view = summarize(c);
      if (view.kind === "idle") hide();
      else show(view);
    },

    updateBatch(v: BatchView): void {
      cancelHide();
      const view = summarizeBatch(v);
      if (view.kind === "idle") hide();
      else show(view);
    },

    flash(view: HudView, ttlMs: number): void {
      if (view.kind === "idle") {
        hide();
        return;
      }
      show(view);
      hideTimer = win.setTimeout(hide, ttlMs);
    },

    onRetry(cb: () => void): void {
      retry = cb;
    },

    /**
     * Blocking confirmation in a native modal dialog.
     *
     * A dialog rather than the pill because this asks permission to spend money:
     * it has to be unmissable and keyboard-reachable, and the pill is a passive
     * status line that hides itself when idle. Only the accept button resolves
     * true — dismissing with Escape counts as declining, because a user who did
     * not say yes has not said yes.
     */
    prompt(view: HudView): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const dlg = doc.createElement("dialog");
        dlg.className = "mt-dialog";
        dlg.setAttribute("data-mt-dialog", view.kind);
        dlg.setAttribute("aria-label", "Xác nhận dịch");

        const text = doc.createElement("p");
        text.className = "mt-dialog__text";
        text.textContent = view.text;

        const actions = doc.createElement("div");
        actions.className = "mt-dialog__actions";

        const accept = doc.createElement("button");
        accept.type = "button";
        accept.dataset.mtAccept = "";
        accept.textContent = "Dịch tiếp";

        const decline = doc.createElement("button");
        decline.type = "button";
        decline.textContent = "Bỏ qua";

        actions.append(accept, decline);
        dlg.append(text, actions);
        doc.body.appendChild(dlg);

        let settled = false;
        const finish = (accepted: boolean): void => {
          if (settled) return;
          settled = true;
          dlg.close();
          dlg.remove();
          resolve(accepted);
        };
        accept.addEventListener("click", () => finish(true));
        decline.addEventListener("click", () => finish(false));
        dlg.addEventListener("cancel", (e) => {
          e.preventDefault();
          finish(false);
        });

        dlg.showModal();
        accept.focus();
      });
    },

    destroy(): void {
      cancelHide();
      pill.remove();
    },
  };
}
