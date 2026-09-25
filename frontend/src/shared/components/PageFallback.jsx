/**
 * Shown while a lazy page chunk is still downloading.
 *
 * Scoped to the content column: the sidebar and header stay mounted, so a tab
 * switch no longer flashes a full-screen unstyled page. Uses the app's own
 * border/surface tokens so it matches the theme instead of raw inline styles.
 */
function Row() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface/40 px-4 py-3">
      <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-border-subtle" />
      <div className="h-3 w-1/3 rounded bg-border-subtle" />
    </div>
  );
}

export function PageFallback() {
  return (
    <div
      className="flex flex-col gap-3"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading page"
    >
      <div className="h-7 w-56 animate-pulse rounded-lg bg-border-subtle" />
      <Row />
      <Row />
      <Row />
    </div>
  );
}

export default PageFallback;
