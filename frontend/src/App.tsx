import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Suspense, lazy } from "react";
import { DashboardLayout } from "@/shared/components/layouts";
import ErrorBoundary from "@/shared/components/ErrorBoundary";

// Lazy-loaded pages (code splitting — loads each page only when needed)
const Landing         = lazy(() => import("./pages/landing/page"));
const Login           = lazy(() => import("./pages/login/page"));
const Callback        = lazy(() => import("./pages/callback/page"));
const Dashboard       = lazy(() => import("./pages/page"));
const Providers       = lazy(() => import("./pages/providers/page"));
const Playground      = lazy(() => import("./pages/playground/page"));
const Models          = lazy(() => import("./pages/models/page"));
const ProviderDetail  = lazy(() => import("./pages/providers/[id]/page"));
const ProvidersNew    = lazy(() => import("./pages/providers/new/page"));
const Usage           = lazy(() => import("./pages/usage/page"));
const Quota           = lazy(() => import("./pages/quota/page"));
const ProxyPools      = lazy(() => import("./pages/proxy-pools/page"));
const Combos          = lazy(() => import("./pages/combos/page"));
const Endpoint        = lazy(() => import("./pages/endpoint/page"));
const Translator      = lazy(() => import("./pages/translator/page"));
const CliTools        = lazy(() => import("./pages/cli-tools/page"));
const CliToolDetail   = lazy(() => import("./pages/cli-tools/[toolId]/page"));
const Automation      = lazy(() => import("./pages/automation/page"));
const BasicChat       = lazy(() => import("./pages/basic-chat/page"));
const Mitm            = lazy(() => import("./pages/mitm/page"));
const Profile         = lazy(() => import("./pages/profile/page"));
const Docs            = lazy(() => import("./pages/docs/page"));
const Skills          = lazy(() => import("./pages/skills/page"));
const ConsoleLog      = lazy(() => import("./pages/console-log/page"));
const MediaProviders  = lazy(() => import("./pages/media-providers/web/page"));
const MediaProviderKind  = lazy(() => import("./pages/media-providers/[kind]/page"));
const MediaProviderKindId = lazy(() => import("./pages/media-providers/[kind]/[id]/page"));
const MediaProviderComboDetail = lazy(() => import("./pages/media-providers/combo/[id]/page"));
const WeavyPool          = lazy(() => import("./pages/providers/weavy/pool/page"));
const AmmailTutorial     = lazy(() => import("./pages/automation/ammail-tutorial/page"));

// Auth guard — check if dashboard session cookie is present
function RequireAuth({ children }: { children: React.ReactNode }) {
  // Simple check — backend /api/auth/status will confirm
  const hasSession = document.cookie.includes("9r_session") ||
                     localStorage.getItem("9r_authed") === "1";
  if (!hasSession) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function LoadingFallback() {
  // Only used for the public routes (login/landing) and the very first paint.
  // Styled with the app's own tokens so there is no unstyled white flash.
  return (
    <div
      className="flex min-h-screen w-full items-center justify-center bg-bg text-text-muted"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="material-symbols-outlined animate-spin">progress_activity</span>
    </div>
  );
}

// One page, one boundary.
//
// React unmounts the whole tree when a render throws and nothing catches it, so
// a single bad page used to blank the entire dashboard — sidebar, header and
// navigation included, with no way to recover short of a refresh. Wrapping each
// page keeps the failure contained: the shell stays interactive, the error is
// reported to the server log, and the user gets a Retry.
//
// A lazy() import that fails to load is also caught here rather than leaving
// the Suspense fallback spinning forever.
function page(element: React.ReactNode, name: string) {
  return <ErrorBoundary name={name}>{element}</ErrorBoundary>;
}

export default function App() {
  return (
    // Last-resort boundary. The per-page boundaries handle almost everything;
    // this one exists so a failure in the shell itself (layout, router) still
    // produces a readable, retryable screen instead of a blank document.
    <ErrorBoundary level="app">
      <BrowserRouter>
        <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* Public */}
          <Route path="/"       element={<Navigate to="/login" replace />} />
          <Route path="/login"  element={<Login />} />
          <Route path="/callback" element={<Callback />} />

          {/* Protected dashboard */}
          <Route path="/dashboard" element={<RequireAuth><DashboardLayout /></RequireAuth>}>
            <Route index element={page(<Dashboard />, "dashboard")} />
            <Route path="providers"       element={page(<Providers />, "providers")} />
            <Route path="playground"      element={page(<Playground />, "playground")} />
            <Route path="models"          element={page(<Models />, "models")} />
            <Route path="providers/new"   element={page(<ProvidersNew />, "new provider")} />
            <Route path="providers/weavy/pool" element={page(<WeavyPool />, "token pool")} />
            <Route path="providers/:id"   element={page(<ProviderDetail />, "provider")} />
            <Route path="usage"           element={page(<Usage />, "usage")} />
            <Route path="quota"           element={page(<Quota />, "quota")} />
            {/* Pricing settings page omitted in v2 currently */}
            <Route path="proxy-pools"     element={page(<ProxyPools />, "proxy pools")} />
            <Route path="combos"          element={page(<Combos />, "combos")} />
            <Route path="endpoint"        element={page(<Endpoint />, "endpoint")} />
            <Route path="translator"      element={page(<Translator />, "translator")} />
            <Route path="cli-tools"       element={page(<CliTools />, "CLI tools")} />
            <Route path="cli-tools/:toolId" element={page(<CliToolDetail />, "CLI tool")} />
            <Route path="automation"      element={page(<Automation />, "automation")} />
            <Route path="automation/ammail-tutorial" element={page(<AmmailTutorial />, "tutorial")} />
            <Route path="basic-chat"      element={page(<BasicChat />, "basic chat")} />
            <Route path="mitm"            element={page(<Mitm />, "MITM")} />
            <Route path="profile"         element={page(<Profile />, "profile")} />
            <Route path="docs"            element={page(<Docs />, "docs")} />
            <Route path="skills"          element={page(<Skills />, "skills")} />
            <Route path="console-log"     element={page(<ConsoleLog />, "console log")} />
            <Route path="media-providers/web" element={page(<MediaProviders />, "media providers")} />
            <Route path="media-providers/:kind" element={page(<MediaProviderKind />, "media providers")} />
            <Route path="media-providers/:kind/:id" element={page(<MediaProviderKindId />, "media provider")} />
            <Route path="media-providers/combo/:id" element={page(<MediaProviderComboDetail />, "combo")} />
          </Route>

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
