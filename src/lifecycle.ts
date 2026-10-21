// Single visibility + page hide subscription fanned out to subscribers.
// Each collector module previously registered its own listeners;
// consolidating here cuts the registration/teardown surface and keeps
// the firing order consistent across modules.

import { attemptCleanup } from "./utils.js";
import { getRuntime, type VisibilityState } from "./runtime.js";

type VisListener = (state: VisibilityState) => void;
type PageHideListener = (persisted: boolean) => void;

let visListeners: VisListener[] = [];
let pageHideListeners: PageHideListener[] = [];

let installed = false;
let visTeardown: (() => void) | null = null;
let pageHideTeardown: (() => void) | null = null;

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

  const runtime = getRuntime();
  visTeardown = runtime.onVisibilityChange((state) => {
    for (const l of visListeners) {
      try { l(state); } catch { /* don't break the chain */ }
    }
  });
  pageHideTeardown = runtime.onPageHide((persisted) => {
    for (const l of pageHideListeners) {
      try { l(persisted); } catch { /* don't break the chain */ }
    }
  });
}

export function destroyLifecycle(): void {
  if (!installed) return;
  visListeners = [];
  pageHideListeners = [];
  // `installed` says our listeners are on the platform, so it goes down only
  // when they are off. A later ensureInstalled must not attach a second pair.
  // A teardown stays referenced until it succeeds, so a later destroy can
  // retry it, the way the network hook keeps the original fetch.
  if (visTeardown && attemptCleanup("visibility listener", visTeardown)) {
    visTeardown = null;
  }
  if (pageHideTeardown && attemptCleanup("pagehide listener", pageHideTeardown)) {
    pageHideTeardown = null;
  }
  installed = visTeardown !== null || pageHideTeardown !== null;
}
