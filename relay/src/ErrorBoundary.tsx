/**
 * Error boundary and 404 page.
 *
 * - ErrorBoundary: catches render errors inside the workspace so one broken
 *   panel never blanks the whole app; offers a clean reload.
 * - NotFoundPage: shown for unknown routes once the client router supports
 *   real paths (the ?view= query router remains authoritative meanwhile).
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[relay] render error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="auth-shell" role="alert">
          <div className="auth-card">
            <h1 className="auth-title">Something went wrong</h1>
            <p className="auth-sub">
              The workspace hit an unexpected error. Your data is safe on the server — reload to continue.
            </p>
            <pre className="auth-error-detail">{this.state.error.message}</pre>
            <button className="btn btn-primary auth-submit" onClick={() => window.location.reload()}>
              <RefreshCw size={15} aria-hidden="true" />
              Reload the workspace
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
