import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import React from "react";
import { ErrorBoundary, withErrorBoundary } from "./index.js";

function ThrowingComponent({ message }: { message: string }) {
  throw new Error(message);
}

function GoodComponent() {
  return <div>All good</div>;
}

describe("ErrorBoundary", () => {
  // Suppress React's console.error for expected errors
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    cleanup();
    console.error = originalError;
  });

  it("renders children when no error", () => {
    const captureError = vi.fn();
    render(
      <ErrorBoundary captureError={captureError}>
        <GoodComponent />
      </ErrorBoundary>,
    );

    expect(screen.getByText("All good")).toBeTruthy();
    expect(captureError).not.toHaveBeenCalled();
  });

  it("shows fallback ReactNode when error occurs", () => {
    const captureError = vi.fn();
    render(
      <ErrorBoundary captureError={captureError} fallback={<p>Oops</p>}>
        <ThrowingComponent message="test crash" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Oops")).toBeTruthy();
    expect(screen.queryByText("All good")).toBeNull();
  });

  it("shows fallback render function when error occurs", () => {
    const captureError = vi.fn();
    render(
      <ErrorBoundary
        captureError={captureError}
        fallback={(error) => <p>Error: {error.message}</p>}
      >
        <ThrowingComponent message="render failed" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Error: render failed")).toBeTruthy();
  });

  it("calls captureError with error and component context", () => {
    const captureError = vi.fn();
    render(
      <ErrorBoundary captureError={captureError} fallback={<p>Fallback</p>}>
        <ThrowingComponent message="caught error" />
      </ErrorBoundary>,
    );

    expect(captureError).toHaveBeenCalledTimes(1);
    const [error, context] = captureError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("caught error");
    expect(context.componentName).toBe("ThrowingComponent");
    expect(context.componentStack).toBeTruthy();
  });

  it("calls onError callback", () => {
    const captureError = vi.fn();
    const onError = vi.fn();
    render(
      <ErrorBoundary captureError={captureError} onError={onError} fallback={<p>F</p>}>
        <ThrowingComponent message="with callback" />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, componentStack] = onError.mock.calls[0];
    expect(error.message).toBe("with callback");
    expect(typeof componentStack).toBe("string");
  });

  it("reset function clears the error and re-renders children", async () => {
    const captureError = vi.fn();
    let shouldThrow = true;

    function MaybeThrow() {
      if (shouldThrow) throw new Error("conditional");
      return <div>Recovered</div>;
    }

    render(
      <ErrorBoundary
        captureError={captureError}
        fallback={(_, reset) => <button onClick={reset}>Retry</button>}
      >
        <MaybeThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Retry")).toBeTruthy();

    // Fix the condition and click retry
    shouldThrow = false;
    const user = userEvent.setup();
    await user.click(screen.getByText("Retry"));

    expect(screen.getByText("Recovered")).toBeTruthy();
  });

  it("renders null when no fallback is provided", () => {
    const captureError = vi.fn();
    const { container } = render(
      <ErrorBoundary captureError={captureError}>
        <ThrowingComponent message="no fallback" />
      </ErrorBoundary>,
    );

    expect(container.innerHTML).toBe("");
    expect(captureError).toHaveBeenCalled();
  });
});

describe("withErrorBoundary", () => {
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    cleanup();
    console.error = originalError;
  });

  it("wraps component in ErrorBoundary", () => {
    const captureError = vi.fn();
    const SafeGood = withErrorBoundary(GoodComponent, {
      captureError,
    });

    render(<SafeGood />);
    expect(screen.getByText("All good")).toBeTruthy();
  });

  it("catches errors from wrapped component", () => {
    const captureError = vi.fn();
    const SafeThrowing = withErrorBoundary(ThrowingComponent, {
      captureError,
      fallback: <p>HOC fallback</p>,
    });

    render(<SafeThrowing message="hoc error" />);
    expect(screen.getByText("HOC fallback")).toBeTruthy();
    expect(captureError).toHaveBeenCalled();
  });

  it("sets displayName", () => {
    const captureError = vi.fn();
    const Wrapped = withErrorBoundary(GoodComponent, { captureError });
    expect(Wrapped.displayName).toBe("withErrorBoundary(GoodComponent)");
  });
});
