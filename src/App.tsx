import React, {
  Component,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { MotionConfig } from "motion/react";
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
  useShelfPreferences,
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
  const { state: shelfPreferences, store: shelfPreferenceStore } = useShelfPreferences();
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closePending, setClosePending] = useState(false);
  const closeRetry = useRef<(() => Promise<void>) | null>(null);
  useLayoutEffect(() => {
    if (!closePending) return;
    // Dialogs render in portals outside the app root. Pause their inputs too
    // so no new saves are enqueued after the exit flush has begun.
    const wasInert = document.body.inert;
    document.body.inert = true;
    return () => {
      document.body.inert = wasInert;
    };
  }, [closePending]);
  useEffect(() => runtime.library.connect(), [runtime]);
  useEffect(() => {
    void runtime.settings.load();
  }, [runtime]);
  useEffect(() => (settings.value ? applyTheme(settings.value) : undefined), [settings.value]);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void listenForClose(
      async (retryFailed = false) => {
        // A previous settings save may already have failed before the native
        // close request. Retry its retained value, then await ordered saves.
        if (runtime.settings.getSnapshot().error) runtime.settings.retry();
        if (shelfPreferenceStore.getSnapshot().error) shelfPreferenceStore.retry();
        await runtime.flush(retryFailed);
      },
      (error, retry) => {
        if (disposed) return;
        closeRetry.current = retry;
        setCloseError(String(error));
      },
      (pending) => {
        if (disposed) return;
        setClosePending(pending);
        if (pending) setCloseError(null);
      },
    )
      .then((fn) => {
        if (disposed) fn();
        else cleanup = fn;
      })
      .catch((error) => {
        if (!disposed) setCloseError(String(error));
      });
    return () => {
      disposed = true;
      cleanup?.();
      closeRetry.current = null;
    };
  }, [runtime, shelfPreferenceStore]);
  return (
    <div
      data-testid={
        !library.loading && !library.error && settings.value && shelfPreferences.value
          ? "app-ready"
          : undefined
      }
      inert={closePending}
      data-exit-pending={closePending ? "true" : undefined}
      className="min-h-screen flex flex-col bg-surface text-on-surface min-w-0"
    >
      <Navbar />
      {closeError && (
        <div role="alert" className="fixed top-0 z-[100] bg-error-container text-error p-3 w-full">
          退出前保存失败：{closeError}
          <button
            className="ml-3 underline"
            onClick={() => {
              if (closeRetry.current) void closeRetry.current();
              else setCloseError(null);
            }}
          >
            {closeRetry.current ? "重试退出" : "返回"}
          </button>
          {(runtime.library.hasUnresolvedWrites() || runtime.shelf.hasUnresolvedWrites()) && (
            <button
              className="ml-3 underline"
              onClick={() => {
                runtime.library.discardFailedWrites();
                runtime.shelf.discardFailedWrites();
                closeRetry.current = null;
                setCloseError(null);
              }}
            >
              放弃未保存的书架操作，返回应用
            </button>
          )}
        </div>
      )}
      <div className={`flex-1 flex flex-col ${activeBook ? "" : "md:pl-64"} min-w-0`}>
        {activeBook ? (
          <ReaderView />
        ) : (
          <div key={activeTab} className="flex-1 flex flex-col min-w-0">
            {activeTab === "bookshelf" ? (
              <BookshelfView />
            ) : activeTab === "discover" ? (
              <DiscoverView />
            ) : activeTab === "subscription" ? (
              <SubscriptionView />
            ) : (
              <SettingsView />
            )}
          </div>
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
