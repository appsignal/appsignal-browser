// Stands in for the `react-native` package in tests, which run without it.
type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";
type Listener = (state: AppStateStatus) => void;

const listeners = new Set<Listener>();

export const AppState = {
  currentState: "active" as AppStateStatus,
  addEventListener(_type: "change", listener: Listener) {
    listeners.add(listener);
    return { remove: () => { listeners.delete(listener); } };
  },
};

export const Platform = { OS: "ios", Version: "27.1" };

export function emitAppState(state: AppStateStatus): void {
  AppState.currentState = state;
  for (const listener of listeners) listener(state);
}

export function appStateListenerCount(): number {
  return listeners.size;
}
