import React, { Component, type ReactNode, useEffect, useState } from "react";
import { MotionConfig, AnimatePresence, motion } from "motion/react";
import { AppProvider, useApp } from "./context/AppContext";
import { tauriServices } from "./services/ipc";
import type { AppServices } from "./services/contracts";
import { listenForClose } from "./services/lifecycle";
import {
  AppRuntime,
  RuntimeContext,
  useRuntime,
  useSettings,
  useLibrary,
} from "./application/runtime";
import { applyTheme } from "./application/theme";
import { Navbar } from "./components/Layout/Navbar";
import { BookshelfView } from "./components/Bookshelf/BookshelfView";
import { DiscoverView } from "./components/Discover/DiscoverView";
import { SubscriptionView } from "./components/Subscription/SubscriptionView";
import { SettingsView } from "./components/Settings/SettingsView";
import { ReaderView } from "./components/Reader/ReaderView";
import { ImportModal } from "./components/Bookshelf/ImportModal";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error in component tree:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-surface text-on-surface text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-red-500/10 text-red-500 flex items-center justify-center text-xl font-bold">
            !
          </div>
          <h2 className="text-lg font-semibold">页面加载遇到问题</h2>
          <p className="text-xs text-secondary max-w-sm">
            {this.state.error?.message || "组件渲染异常，请点击重试"}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-medium cursor-pointer"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function MainContent() {
  const { activeTab, activeBook } = useApp();
  const runtime = useRuntime();
  const { state: library } = useLibrary();
  const { state: settings } = useSettings();
  const [closeError, setCloseError] = useState<string | null>(null);
  useEffect(() => runtime.library.connect(), [runtime]);
  useEffect(() => {
    void runtime.settings.load();
  }, [runtime]);
  useEffect(() => (settings.value ? applyTheme(settings.value) : undefined), [settings.value]);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void listenForClose(runtime.flush, (error) => setCloseError(String(error)))
      .then((fn) => {
        if (disposed) fn();
        else cleanup = fn;
      })
      .catch((error) => setCloseError(String(error)));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [runtime]);
  return (
    <div
      data-testid={!library.loading && !library.error && settings.value ? "app-ready" : undefined}
      className="min-h-screen flex flex-col bg-surface text-on-surface min-w-0"
    >
      <Navbar />
      {closeError && (
        <div role="alert" className="fixed top-0 z-[100] bg-error-container text-error p-3 w-full">
          退出前保存失败：{closeError}
          <button className="ml-3 underline" onClick={() => setCloseError(null)}>
            返回重试
          </button>
        </div>
      )}
      <div className={`flex-1 flex flex-col ${activeBook ? "" : "md:pl-64"} min-w-0`}>
        {activeBook ? (
          <ReaderView />
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activeTab}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex flex-col min-w-0"
            >
              {activeTab === "bookshelf" ? (
                <BookshelfView />
              ) : activeTab === "discover" ? (
                <DiscoverView />
              ) : activeTab === "subscription" ? (
                <SubscriptionView />
              ) : (
                <SettingsView />
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      <ImportModal />
    </div>
  );
}
export function App({ services = tauriServices }: { services?: AppServices }) {
  const [runtime] = useState(() => new AppRuntime(services));
  return (
    <ErrorBoundary>
      <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: "easeOut" }}>
        <RuntimeContext.Provider value={runtime}>
          <AppProvider>
            <MainContent />
          </AppProvider>
        </RuntimeContext.Provider>
      </MotionConfig>
    </ErrorBoundary>
  );
}
