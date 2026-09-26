import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isChunkLoadError, reloadApp } from "@/lib/chunkLoadError";

type RouteErrorBoundaryProps = {
  children: ReactNode;
  onOpenLibrary: () => void;
  resetKey: string;
  title: string;
  message: string;
  retryLabel: string;
  libraryLabel: string;
  /** Shown instead when the page's code belongs to a version the server no longer has. */
  staleVersionTitle: string;
  staleVersionMessage: string;
  reloadLabel: string;
};

type RouteErrorBoundaryState = {
  hasError: boolean;
  staleVersion: boolean;
  resetKey: string;
};

export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { hasError: false, staleVersion: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(
    props: RouteErrorBoundaryProps,
    state: RouteErrorBoundaryState,
  ): RouteErrorBoundaryState | null {
    if (props.resetKey === state.resetKey) return null;
    return { hasError: false, staleVersion: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error: unknown): Partial<RouteErrorBoundaryState> {
    return { hasError: true, staleVersion: isChunkLoadError(error) };
  }

  private retry = () => {
    this.setState({ hasError: false, staleVersion: false });
  };

  private openLibrary = () => {
    this.setState({ hasError: false, staleVersion: false });
    this.props.onOpenLibrary();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    const { staleVersion } = this.state;

    return (
      <div className="py-5 pl-[max(1rem,var(--safe-area-left))] pr-[max(1rem,var(--safe-area-right))] lg:px-6">
        <section
          className="mx-auto max-w-2xl rounded-lg border bg-card p-6"
          role="alert"
          aria-labelledby="route-error-title"
        >
          <div className="grid h-10 w-10 place-items-center rounded-md bg-destructive/10 text-destructive">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2 id="route-error-title" className="mt-4 text-lg font-semibold">
            {staleVersion ? this.props.staleVersionTitle : this.props.title}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {staleVersion ? this.props.staleVersionMessage : this.props.message}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {staleVersion ? (
              // Retrying would request the same missing chunk; the new app shell names the current ones.
              <Button onClick={reloadApp}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {this.props.reloadLabel}
              </Button>
            ) : (
              <Button onClick={this.retry}>{this.props.retryLabel}</Button>
            )}
            <Button variant="outline" onClick={this.openLibrary}>
              {this.props.libraryLabel}
            </Button>
          </div>
        </section>
      </div>
    );
  }
}

/**
 * Contains a failure of an optional overlay, such as a lazily loaded dialog,
 * so it cannot unmount the app shell and the global player. It renders
 * nothing after reporting the error; remounting it tries again.
 */
export class OverlayErrorBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}
