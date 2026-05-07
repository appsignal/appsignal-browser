// Single visibilitychange + pagehide listener fanned out to subscribers.
// Each collector module previously registered its own DOM listeners;
// consolidating here cuts the registration/teardown surface and keeps
// the firing order consistent across modules.

type VisListener = (state: DocumentVisibilityState) => void;
type PageHideListener = (persisted: boolean) => void;

let visListeners: VisListener[] = [];
let pageHideListeners: PageHideListener[] = [];

let installed = false;
let visHandler: (() => void) | null = null;
let pageHideHandler: ((e: PageTransitionEvent) => void) | null = null;

export function onVisibilityChange(fn: VisListener): () => void {
  visListeners.push(fn);
  ensureInstalled();
  return () => {
    const i = visListeners.indexOf(fn);
    if (i >= 0) visListeners.splice(i, 1);
  };
}

export function onPageHide(fn: PageHideListener): () => void {
  pageHideListeners.push(fn);
  ensureInstalled();
  return () => {
    const i = pageHideListeners.indexOf(fn);
    if (i >= 0) pageHideListeners.splice(i, 1);
  };
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;

  visHandler = () => {
    const state = document.visibilityState;
    for (const l of visListeners) {
      try { l(state); } catch { /* don't break the chain */ }
    }
  };
  document.addEventListener("visibilitychange", visHandler);

  pageHideHandler = (e: PageTransitionEvent) => {
    for (const l of pageHideListeners) {
      try { l(e.persisted); } catch { /* don't break the chain */ }
    }
  };
  window.addEventListener("pagehide", pageHideHandler as EventListener);
}

export function destroyLifecycle(): void {
  if (!installed) return;
  if (visHandler) {
    document.removeEventListener("visibilitychange", visHandler);
    visHandler = null;
  }
  if (pageHideHandler) {
    window.removeEventListener("pagehide", pageHideHandler as EventListener);
    pageHideHandler = null;
  }
  visListeners = [];
  pageHideListeners = [];
  installed = false;
}
