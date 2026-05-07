import { describe, it, expect, vi, afterEach } from "vitest";
import {
  onVisibilityChange,
  onPageHide,
  destroyLifecycle,
} from "./lifecycle.js";

describe("lifecycle", () => {
  afterEach(() => {
    destroyLifecycle();
    vi.restoreAllMocks();
  });

  it("installs a single visibilitychange listener regardless of subscriber count", () => {
    const docAdd = vi.spyOn(document, "addEventListener");

    onVisibilityChange(() => {});
    onVisibilityChange(() => {});
    onVisibilityChange(() => {});

    const visAdds = docAdd.mock.calls.filter(([type]) => type === "visibilitychange");
    expect(visAdds).toHaveLength(1);
  });

  it("installs a single pagehide listener regardless of subscriber count", () => {
    const winAdd = vi.spyOn(window, "addEventListener");

    onPageHide(() => {});
    onPageHide(() => {});

    const pageHideAdds = winAdd.mock.calls.filter(([type]) => type === "pagehide");
    expect(pageHideAdds).toHaveLength(1);
  });

  it("fans out visibilitychange to every subscriber", () => {
    const seen: DocumentVisibilityState[] = [];
    onVisibilityChange((state) => seen.push(state));
    onVisibilityChange((state) => seen.push(state));

    document.dispatchEvent(new Event("visibilitychange"));

    expect(seen).toHaveLength(2);
  });

  it("unregister stops a single subscriber without affecting others", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onVisibilityChange(a);
    onVisibilityChange(b);

    offA();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
