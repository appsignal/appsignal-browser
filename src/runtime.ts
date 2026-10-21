// The platform under the SDK. Every read of a page global and every global
// listener goes through here, so one adapter per platform is the whole
// difference between the browser and React Native. The browser is the
// default; the React Native entry point installs its own before init.

export type VisibilityState = "visible" | "hidden";

export interface UncaughtError {
  message: string;
  /** The thrown value or rejection reason, when the platform hands it over. */
  error?: unknown;
  filename?: string;
  lineno?: number;
  colno?: number;
  /** True for an unhandled promise rejection; `error` is then the reason. */
  rejection?: boolean;
}

export interface Runtime {
  /** True when a document is present. The click, navigation, document load,
   * resource timing, long task and scroll collectors run only then. */
  dom: boolean;
  /** The URL the error payload reports. Empty when the platform has none. */
  pageUrl(): string;
  /** The error action when the host set no route template. */
  pagePath(): string;
  userAgent(): string;
  isOnline(): boolean;
  /** Call the listener once, the next time the device comes online. */
  onOnline(listener: () => void): () => void;
  onUncaughtError(listener: (error: UncaughtError) => void): () => void;
  onVisibilityChange(listener: (state: VisibilityState) => void): () => void;
  onPageHide(listener: (persisted: boolean) => void): () => void;
  /** User input that keeps the session alive. */
  onActivity(listener: () => void): () => void;
  /** Another context changed a stored value. */
  onStorageChange(listener: (key: string | null, newValue: string | null) => void): () => void;
}

const ACTIVITY_EVENTS = ["click", "keydown", "scroll"];

export const browserRuntime: Runtime = {
  dom: true,
  pageUrl: () => location.href,
  pagePath: () => location.pathname,
  userAgent: () => navigator.userAgent,
  // Unknown counts as online: a browser that does not report the flag still
  // has a network.
  isOnline: () => navigator.onLine !== false,
  onOnline(listener) {
    window.addEventListener("online", listener, { once: true });
    return () => window.removeEventListener("online", listener);
  },
  onUncaughtError(listener) {
    const onError = (event: ErrorEvent) => listener({
      message: event.message,
      error: event.error,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
    const onRejection = (event: PromiseRejectionEvent) => listener({
      message: "",
      error: event.reason,
      rejection: true,
    });
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  },
  onVisibilityChange(listener) {
    const handler = () => listener(document.visibilityState);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  },
  onPageHide(listener) {
    const handler = (event: PageTransitionEvent) => listener(event.persisted);
    window.addEventListener("pagehide", handler as EventListener);
    return () => window.removeEventListener("pagehide", handler as EventListener);
  },
  onActivity(listener) {
    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, listener, { passive: true, capture: true });
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, listener, { capture: true });
      }
    };
  },
  onStorageChange(listener) {
    const handler = (event: StorageEvent) => listener(event.key, event.newValue);
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  },
};

let current: Runtime = browserRuntime;

export function getRuntime(): Runtime {
  return current;
}

export function setRuntime(runtime: Runtime): void {
  current = runtime;
}
