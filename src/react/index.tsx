import { Component, type ReactNode, type ErrorInfo } from "react";

type CaptureErrorFn = (
  error: Error,
  context?: { componentName?: string; [key: string]: unknown },
) => void;

interface ErrorBoundaryProps {
  /** The captureError function from @appsignal/browser. Required. */
  captureError: CaptureErrorFn;
  /** Fallback UI to show when an error occurs. Receives the error and a reset function. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Called when an error is caught, before sending to AppSignal. */
  onError?: (error: Error, componentStack: string) => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React ErrorBoundary that captures render errors and sends them to AppSignal.
 *
 * Usage:
 * ```tsx
 * import { ErrorBoundary } from "@appsignal/browser/react";
 * import { captureError } from "@appsignal/browser";
 *
 * <ErrorBoundary captureError={captureError} fallback={<p>Something went wrong</p>}>
 *   <App />
 * </ErrorBoundary>
 *
 * // Or with a render function for reset capability:
 * <ErrorBoundary captureError={captureError} fallback={(error, reset) => (
 *   <div>
 *     <p>Error: {error.message}</p>
 *     <button onClick={reset}>Try again</button>
 *   </div>
 * )}>
 *   <App />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack || "";

    this.props.onError?.(error, componentStack);

    this.props.captureError(error, {
      componentName: parseComponentName(componentStack),
      componentStack,
    });
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      const { fallback } = this.props;
      if (typeof fallback === "function") {
        return fallback(this.state.error, this.reset);
      }
      if (fallback !== undefined) {
        return fallback;
      }
      return null;
    }
    return this.props.children;
  }
}

function parseComponentName(componentStack: string): string {
  const match = componentStack.match(/^\s*at\s+(\S+)/);
  return match?.[1] || "unknown";
}

/**
 * HOC that wraps a component in an ErrorBoundary.
 *
 * Usage:
 * ```tsx
 * import { withErrorBoundary } from "@appsignal/browser/react";
 * import { captureError } from "@appsignal/browser";
 *
 * const SafeWidget = withErrorBoundary(Widget, {
 *   captureError,
 *   fallback: <p>Widget failed to load</p>,
 * });
 * ```
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  boundaryProps: Omit<ErrorBoundaryProps, "children">,
): React.FC<P> {
  const displayName = WrappedComponent.displayName || WrappedComponent.name || "Component";

  const WithBoundary: React.FC<P> = (props) => (
    <ErrorBoundary {...boundaryProps}>
      <WrappedComponent {...props} />
    </ErrorBoundary>
  );

  WithBoundary.displayName = `withErrorBoundary(${displayName})`;
  return WithBoundary;
}
