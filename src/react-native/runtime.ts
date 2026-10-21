import { AppState, Platform } from "react-native";
import type { Runtime } from "../runtime.js";
import { errorLike } from "../utils.js";

const noop = (): void => {};

/** React Native has no document, no location and no storage. Uncaught errors
 * arrive through `ErrorUtils`, and foreground changes through `AppState`.
 * The network is taken to be up: a request that fails retries on its own. */
export const reactNativeRuntime: Runtime = {
  dom: false,
  pageUrl: () => "",
  pagePath: () => "",
  userAgent: () => `react-native ${Platform.OS} ${Platform.Version}`,
  isOnline: () => true,
  onOnline: () => noop,
  onUncaughtError(listener) {
    if (typeof ErrorUtils === "undefined" || !ErrorUtils) return noop;
    const errorUtils = ErrorUtils;
    const previous = errorUtils.getGlobalHandler();
    const handler = (error: unknown, isFatal?: boolean) => {
      const asError = errorLike(error);
      listener({ message: asError ? asError.message : String(error), error });
      // React Native's own handler shows the error in development and ends
      // the app on a fatal error in production.
      if (previous) previous(error, isFatal);
    };
    errorUtils.setGlobalHandler(handler);
    return () => {
      if (errorUtils.getGlobalHandler() === handler) errorUtils.setGlobalHandler(previous);
    };
  },
  onVisibilityChange(listener) {
    const subscription = AppState.addEventListener("change", (state) => {
      listener(state === "active" ? "visible" : "hidden");
    });
    return () => subscription.remove();
  },
  onPageHide: () => noop,
  onActivity: () => noop,
  onStorageChange: () => noop,
};
