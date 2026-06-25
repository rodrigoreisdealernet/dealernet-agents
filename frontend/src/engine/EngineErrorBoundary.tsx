/**
 * EngineErrorBoundary
 *
 * React error boundary for the JSON-driven UI engine.
 * Prevents an unexpected throw inside a component tree from blanking the
 * entire page by rendering a visible fallback instead.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Optional fallback to render instead of the default error message. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * EngineErrorBoundary — catches render errors and shows an inline fallback.
 * Use this at the page level (UIEngine) and at the card-content level
 * (EngineCard) so that a crash in card content never removes the card title.
 */
export class EngineErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: unknown): State {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = (info.componentStack ?? '').replace(/\n/g, ' ').trim();
    console.error(`[UIEngine] Render error caught by boundary: ${msg} | componentStack: ${stack}`);
  }

  handleRetry = () => {
    this.setState({ hasError: false, message: '' });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback !== undefined) {
        return this.props.fallback;
      }
      return (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive"
        >
          <p className="font-medium">Unable to display this content.</p>
          <p className="mt-1 text-xs text-muted-foreground">{this.state.message}</p>
          <button
            type="button"
            aria-label="Retry loading content"
            onClick={this.handleRetry}
            className="mt-2 text-xs underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
