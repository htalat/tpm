import { BrowserRouter, Route, Routes } from "react-router-dom";
import { FlashProvider, Masthead } from "./components";
import IndexPage from "./pages/IndexPage";

// Route table grows with the migration (part 4 adds task detail, search,
// runs, logs, config). The router basename matches vite's `base: "/app/"` —
// the SSR pages own everything outside /app until parity.
export default function App() {
  return (
    <BrowserRouter basename="/app">
      <FlashProvider>
        <div className="mx-auto max-w-5xl px-4 py-6 text-neutral-900 dark:text-neutral-100">
          <Masthead />
          <Routes>
            <Route path="/" element={<IndexPage />} />
            <Route path="*" element={<p className="text-sm text-neutral-500">Not found. <a className="text-blue-600 dark:text-blue-400" href="/app">Back to index</a></p>} />
          </Routes>
        </div>
      </FlashProvider>
    </BrowserRouter>
  );
}
