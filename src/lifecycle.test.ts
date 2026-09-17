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

describe("lifecycle teardown that the browser refuses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    destroyLifecycle();
  });

  it("keeps the handler so a later destroy can retry the detach", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    onVisibilityChange(() => {});
    const docRemove = vi.spyOn(document, "removeEventListener").mockImplementationOnce(() => {
      throw new Error("foreign listener cleanup failed");
    });
    const docAdd = vi.spyOn(document, "addEventListener");

    destroyLifecycle();

    // Still installed: a new subscriber must not attach a second listener,
    // because the first one is still on the document and still dispatches.
    onVisibilityChange(() => {});
    expect(docAdd.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);

    // The retry detaches the same handler the first attempt could not.
    destroyLifecycle();
    const removals = docRemove.mock.calls.filter(([type]) => type === "visibilitychange");
    expect(removals).toHaveLength(2);
    expect(removals[0][1]).toBe(removals[1][1]);

    onVisibilityChange(() => {});
    expect(docAdd.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  });
});
