// The page-level status pill. Pure DOM (no chrome.*): callers feed it Counts and
// it decides what the user sees, so a 12-25s cold translation still reads as
// "working" instead of "broken".

import { summarize, summarizeBatch, type BatchView, type Counts, type HudView } from "./hudstate";

export interface Hud {
  /** Show or hide a Stop control inside the status pill. A control inside the
   * pill rather than a separate fixed button, because a separate button shares
   * the pill's corner and the two overlap. Firing `onStop` twice must be safe:
   * a keypress and a click can land together.
   */
  setStop(active: boolean, onStop?: () => void): void;
  /**
   * Hold-to-peek control: pressing shows the page's original art, releasing
   * puts the translations back. Fired with `false` more than once per hold is
   * safe, so a lost pointer does not leave the page stuck on the original.
   */
  setPeek(onPeek: (hold: boolean) => void): void;
  /** Edit-mode toggle, drawn with its pressed state. */
  setEdit(active: boolean, onToggle: (on: boolean) => void): void;
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
.mt-hud__stop{font:inherit;padding:0.2rem 0.6rem;border-radius:999px;border:0;background:#b3261e;color:#fff;cursor:pointer}
.mt-hud__peek,.mt-hud__edit{font:inherit;padding:0.2rem 0.6rem;border-radius:999px;border:0;background:#4f8cff;color:#fff;cursor:pointer}
.mt-hud__edit[aria-pressed="true"]{background:#0b6b32}
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
  // Pointer drag must win over touch scrolling on the pill itself.
  pill.style.touchAction = "none";
  pill.style.cursor = "grab";
  doc.body.appendChild(pill);

  const label = doc.createElement("span");
  label.className = "mt-hud__label";
  const spinner = doc.createElement("span");
  spinner.className = "mt-spin";
  spinner.setAttribute("aria-hidden", "true");

  let kind: HudView["kind"] = "idle";
  let hideTimer: number | undefined;
  let retry: (() => void) | undefined;
  let stopBtn: HTMLButtonElement | null = null;
  let stopCb: (() => void) | undefined;
  let peekBtn: HTMLButtonElement | null = null;
  let peekCb: ((hold: boolean) => void) | undefined;
  let editBtn: HTMLButtonElement | null = null;
  let editCb: ((on: boolean) => void) | undefined;
  let editActive = false;
  // Pointer position where the current press started; a press that barely
  // moves is a click (retry/stop), not a drag, so both gestures share the pill.
  let press: { x: number; y: number; left: number; top: number } | null = null;
  let dragged = false;
  const DRAG_PX = 4;

  function show(view: HudView): void {
    cancelHide();
    kind = view.kind;
    label.textContent = view.text;
    pill.className = `mt-hud mt-hud--${view.tone}`;
    pill.setAttribute("data-tone", view.tone);
    pill.setAttribute("data-kind", view.kind);
    pill.replaceChildren(...(wantsSpinner(view.kind) ? [spinner, label] : [label]));
    syncControls();
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

  function syncControls(): void {
    // show() rebuilds the pill's children, which detaches the controls.
    for (const control of [stopBtn, peekBtn, editBtn]) {
      if (control && !pill.contains(control)) pill.appendChild(control);
    }
  }

  function makeControl(className: string, text: string): HTMLButtonElement {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.dataset.mtHud = "";
    btn.textContent = text;
    return btn;
  }

  // The whole pill is the drag handle: no separate grip, so there is nothing
  // extra to discover or to overlap the text. A press starting on one of the
  // pill's controls or moving less than DRAG_PX stays a click (stop/retry and
  // the hold controls keep working).
  function onMove(e: PointerEvent): void {
    if (!press) return;
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!dragged && Math.hypot(dx, dy) < DRAG_PX) return;
    dragged = true;
    pill.style.left = `${Math.round(press.left + dx)}px`;
    pill.style.top = `${Math.round(press.top + dy)}px`;
    pill.style.right = "auto";
    pill.style.bottom = "auto";
  }
  function endPress(): void {
    press = null;
  }
  pill.addEventListener("pointerdown", (e) => {
    // Touch presses carry no meaningful button; only gate the mouse.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if ((e.target as Element | null)?.closest?.(".mt-hud__stop, .mt-hud__peek, .mt-hud__edit")) return;
    const r = pill.getBoundingClientRect();
    press = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    dragged = false;
  });
  doc.addEventListener("pointermove", onMove);
  doc.addEventListener("pointerup", endPress);
  doc.addEventListener("pointercancel", endPress);

  // A click on a settled "done" or a running batch must not look like a retry to
  // the user, so the handler is gated on the state that actually offers one.
  // A click that ends a drag must not retry either: the press moved, so it was
  // never a click on the error text.
  pill.addEventListener("click", () => {
    if (dragged) {
      dragged = false;
      return;
    }
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

    setStop(active: boolean, onStop?: () => void): void {
      // The stop control lives inside the pill: a separate fixed button shares
      // the pill's corner and the two overlap. Firing twice is safe because a
      // keypress and a click can land together.
      if (!active) {
        stopCb = undefined;
        stopBtn?.remove();
        stopBtn = null;
        syncControls();
        return;
      }
      if (onStop) stopCb = onStop;
      if (!stopBtn) {
        const btn = makeControl("mt-hud__stop", "D\u1eebng");
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          stopCb?.();
        });
        stopBtn = btn;
      }
      syncControls();
      if (pill.style.display === "none") pill.style.display = "flex";
    },

    setPeek(onPeek: (hold: boolean) => void): void {
      peekCb = onPeek;
      if (!peekBtn) {
        const btn = makeControl("mt-hud__peek", "G\u1ed1c");
        btn.title = "Gi\u1eef \u0111\u1ec3 xem \u1ea3nh g\u1ed1c";
        const release = (): void => peekCb?.(false);
        // reveal/release rather than click: the original is only on screen
        // while the button is held, which is what makes comparing a page safe.
        btn.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          peekCb?.(true);
        });
        for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
          btn.addEventListener(type, release);
        }
        // Keyboard hold: space/enter repeats while held, and every repeated
        // "true" is a no-op, so only the release matters.
        btn.addEventListener("keydown", (e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          peekCb?.(true);
        });
        btn.addEventListener("keyup", (e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          release();
        });
        btn.addEventListener("blur", release);
        peekBtn = btn;
      }
      syncControls();
    },

    setEdit(active: boolean, onToggle: (on: boolean) => void): void {
      editActive = active;
      editCb = onToggle;
      if (!editBtn) {
        const btn = makeControl("mt-hud__edit", "S\u1eeda");
        btn.title = "B\u1eadt/t\u1eaft ch\u1ebf \u0111\u1ed9 s\u1eeda ch\u1eef (Alt+E)";
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          editCb?.(!editActive);
        });
        editBtn = btn;
      }
      editBtn.setAttribute("aria-pressed", String(editActive));
      syncControls();
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
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", endPress);
      doc.removeEventListener("pointercancel", endPress);
      pill.remove();
    },
  };
}
