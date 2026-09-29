import { Component } from "react";
import PropTypes from "prop-types";
import { reportError } from "@/shared/utils/clientErrorReporting";

// ── ErrorBoundary ────────────────────────────────────────────────
//
// WHY THIS EXISTS
// React unmounts the ENTIRE tree when a render throws and no boundary catches
// it. One bad page therefore produced a completely blank application: the
// sidebar, the header and the route switch were all destroyed, with nothing
// on screen to explain why. That is the "blank screen" this boundary prevents.
//
// Two levels are used (see App.tsx):
//   - one per page, so a failure is contained and the user can retry or move
//     on while the shell stays interactive;
//   - one at the root, as a last resort.
//
// The error is REPORTED before rendering the fallback, so a failure is
// diagnosable from the server log even though the UI no longer shows a stack.
// Credentials are scrubbed in the reporter, not here.

const TITLES = {
  page: "This page could not be displayed",
  app: "The dashboard could not be displayed",
};

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, attempt: 0 };
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // Best-effort: a reporting failure must not re-throw into React.
    try {
      reportError(error, {
        component: this.props.name || (this.props.level === "app" ? "App" : "Page"),
      });
    } catch {
      /* ignore */
    }
    this.props.onError?.(error, info);
  }

  handleRetry() {
    // Remounting the subtree is what actually retries: clearing the error lets
    // React re-render the children, and the incremented attempt key forces new
    // component instances rather than reusing broken ones.
    this.setState((s) => ({ error: null, info: null, attempt: s.attempt + 1 }));
  }

  render() {
    const { error, attempt } = this.state;
    const { children, level = "page", name } = this.props;
    if (!error) {
      return <div key={attempt} style={{ display: "contents" }}>{children}</div>;
    }

    // A custom fallback (e.g. the page skeleton chrome) can be supplied.
    if (this.props.fallback) return this.props.fallback(error, this.handleRetry);

    return (
      <div
        role="alert"
        className="flex min-h-[40vh] w-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
      >
        <span
          className="material-symbols-outlined text-4xl text-amber-500"
          aria-hidden="true"
        >
          error
        </span>
        <h2 className="text-base font-semibold">
          {TITLES[level] || TITLES.page}
        </h2>
        <p className="max-w-md text-sm text-text-muted">
          {name ? `The ${name} view hit an unexpected error.` : "An unexpected error occurred."}{" "}
          The rest of the dashboard is still usable — you can retry, or navigate to
          another page.
        </p>
        <details className="max-w-md text-left text-xs text-text-muted">
          <summary className="cursor-pointer select-none">Technical detail</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-sidebar/40 p-2 font-mono text-[11px]">
            {String(error?.message || error)}
          </pre>
        </details>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-lg border border-primary/40 px-3 py-1.5 text-xs text-primary transition-colors hover:border-primary hover:bg-primary/5"
          >
            Retry
          </button>
          {level !== "app" && (
            <a
              href="/dashboard"
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
            >
              Back to dashboard
            </a>
          )}
        </div>
      </div>
    );
  }
}

ErrorBoundary.propTypes = {
  children: PropTypes.node,
  level: PropTypes.oneOf(["page", "app"]),
  name: PropTypes.string,
  fallback: PropTypes.func,
  onError: PropTypes.func,
};

export default ErrorBoundary;
