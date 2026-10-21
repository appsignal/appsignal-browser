// The parts of React Native the SDK uses. The package itself is not a
// dependency of this repository, and the host's copy supplies the full types.
declare module "react-native" {
  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";
  export const AppState: {
    currentState: AppStateStatus;
    addEventListener(type: "change", listener: (state: AppStateStatus) => void): { remove(): void };
  };
  export const Platform: {
    OS: string;
    Version: string | number;
  };
}

type ReactNativeErrorHandler = (error: unknown, isFatal?: boolean) => void;

declare const ErrorUtils: {
  getGlobalHandler(): ReactNativeErrorHandler;
  setGlobalHandler(handler: ReactNativeErrorHandler): void;
} | undefined;
