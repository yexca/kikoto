import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

type RouteErrorBoundaryProps = {
  children: ReactNode;
  onOpenLibrary: () => void;
  resetKey: string;
};

type RouteErrorBoundaryState = {
  hasError: boolean;
  resetKey: string;
};

export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { hasError: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(
    props: RouteErrorBoundaryProps,
    state: RouteErrorBoundaryState,
  ): RouteErrorBoundaryState | null {
    if (props.resetKey === state.resetKey) return null;
    return { hasError: false, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<RouteErrorBoundaryState> {
    return { hasError: true };
  }

  private retry = () => {
    this.setState({ hasError: false });
  };

  private openLibrary = () => {
    this.setState({ hasError: false });
    this.props.onOpenLibrary();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="py-5 pl-[max(1rem,var(--safe-area-left))] pr-[max(1rem,var(--safe-area-right))] lg:px-6">
        <section className="mx-auto max-w-2xl rounded-lg border bg-card p-6" role="alert" aria-labelledby="route-error-title">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-destructive/10 text-destructive">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <h2 id="route-error-title" className="mt-4 text-lg font-semibold">
            Page unavailable
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Kikoto could not display this page. The player and navigation are still available.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button onClick={this.retry}>Retry page</Button>
            <Button variant="outline" onClick={this.openLibrary}>
              Open Library
            </Button>
          </div>
        </section>
      </div>
    );
  }
}
