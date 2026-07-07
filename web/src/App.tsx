import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary, FlashProvider, Masthead, SkewBanner } from "./components";
import IndexPage from "./pages/IndexPage";
import BoardPage from "./pages/BoardPage";
import TaskPage from "./pages/TaskPage";
import ProjectPage from "./pages/ProjectPage";
import SearchPage from "./pages/SearchPage";
import RunsPage from "./pages/RunsPage";
import LogsPage from "./pages/LogsPage";
import ConfigPage from "./pages/ConfigPage";

// The SPA owns the whole surface now; the SSR pages stay reachable at their
// original paths (each page's "classic" link). The router basename matches
// vite's `base: "/app/"`.
export default function App() {
  return (
    <BrowserRouter basename="/app">
      <FlashProvider>
        <div className="mx-auto max-w-5xl px-4 py-6 text-ink">
          <Masthead />
          <SkewBanner />
          <RoutedBoundary>
          <Routes>
            <Route path="/" element={<IndexPage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/config" element={<ConfigPage />} />
            <Route path="/p/:slug" element={<ProjectPage />} />
            {/* Task paths nest arbitrarily (project/parent/child) — match the
                wildcard and let the pages split the slug path themselves. */}
            <Route path="/t/*" element={<TaskOrRuns />} />
            <Route path="*" element={<p className="text-sm text-muted">Not found.</p>} />
          </Routes>
          </RoutedBoundary>
        </div>
      </FlashProvider>
    </BrowserRouter>
  );
}

// Reset the boundary on navigation: a crash on one page shouldn't wedge the
// next one.
function RoutedBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>;
}

function TaskOrRuns() {
  const { pathname } = useLocation();
  return pathname.endsWith("/runs") ? <RunsPage /> : <TaskPage />;
}
