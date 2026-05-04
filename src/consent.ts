export type ConsentState = "granted" | "not-granted" | "pending";

let state: ConsentState = "granted";
const onGrantCallbacks: (() => void)[] = [];
const onDenyCallbacks: (() => void)[] = [];

export function getConsent(): ConsentState {
  return state;
}

export function setConsent(newState: ConsentState): void {
  const prev = state;
  state = newState;

  if (newState === "granted" && prev !== "granted") {
    for (const cb of onGrantCallbacks) { try { cb(); } catch { /* don't break chain */ } }
  }
  if (newState === "not-granted" && prev !== "not-granted") {
    for (const cb of onDenyCallbacks) { try { cb(); } catch { /* don't break chain */ } }
  }
}

export function onConsentGranted(cb: () => void): void {
  onGrantCallbacks.push(cb);
}

export function onConsentDenied(cb: () => void): void {
  onDenyCallbacks.push(cb);
}

export function destroyConsent(): void {
  onGrantCallbacks.length = 0;
  onDenyCallbacks.length = 0;
  state = "pending";
}
