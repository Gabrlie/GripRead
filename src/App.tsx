import React, {
  Component,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { MotionConfig } from "motion/react";
import { AppProvider, useApp } from "./context/AppContext";
import { tauriServices } from "./services/ipc";
import type { AppServices } from "./services/contracts";
import { Toaster, setLogViewer, toast } from "./components/ui/toast";
import { LogPage } from "./components/Settings/LogPage";
import {
  dismissWithEscape,
  flushWhenHidden,
  listenForBack,
  listenForClose,
} from "./services/lifecycle";
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
import { UpdatePrompt } from "./components/Updates/UpdatePrompt";
import { DisclaimerPrompt } from "./components/Layout/Disclaimer";
import { t, useLocale } from "./i18n";

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
          <h2 className="text-lg font-semibold">{t("app.crash")}</h2>
          <p className="text-xs text-secondary max-w-sm">
            {this.state.error?.message || t("app.crash.note")}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false })}
            className="px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-medium cursor-pointer"
          >
            {t("common.retry")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Open dialogs, drawers, and menus that close on Escape. */
const OPEN_LAYER =
  '[role="dialog"][data-open], [role="alertdialog"][data-open], [role="menu"][data-open]';

function MainContent() {
  const { activeTab, activeBook, setActiveTab } = useApp();
  const runtime = useRuntime();
  const [showLogs, setShowLogs] = useState(false);
  useEffect(() => {
    setLogViewer(() => setShowLogs(true));
    return () => setLogViewer(null);
  }, []);
  // Records from the GripRead server changed the library or preferences.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void runtime.services.sync
      .onSyncApplied(() => {
        void runtime.library.refresh();
        void runtime.settings.load();
        void runtime.shelfPreferences.load();
      })
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [runtime]);
  // A changed network or proxy (a proxy app turned off) is checked again,
  // once the burst of change reports settles.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settings = runtime.services.settings;
    void settings
      .onNetworkChange(() => {
        clearTimeout(timer);
        timer = setTimeout(() => void settings.networkState().catch(() => undefined), 500);
      })
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      });
    return () => {
      active = false;
      clearTimeout(timer);
      stop?.();
    };
  }, [runtime]);
  // A source set to 通过服务器访问 that had to go direct says so, once.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    void runtime.services.sources
      .onNotice?.((notice) =>
        toast({
          text: t("src.relayFallback", { source: notice.source, message: notice.message }),
          error: true,
        }),
      )
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [runtime]);
  // The Android download notification's 停止 pauses the queue.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let active = true;
    const sources = runtime.services.sources;
    void sources
      .onDownloadStop(() => void sources.pauseAllDownloads())
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [runtime]);
  const positionError = useSyncExternalStore(
    runtime.positions.subscribe,
    runtime.positions.getSnapshot,
  );
  const readerWriteError = useSyncExternalStore(runtime.subscribeReader, runtime.getReaderError);
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
    // The daily WebDAV backup; failures are shown in 设置 › 备份与恢复.
    void runtime.services.sync.runAutomaticBackup().catch(() => undefined);
  }, [runtime]);
  useEffect(() => (settings.value ? applyTheme(settings.value) : undefined), [settings.value]);
  // 外观 › 主界面: the page the app opens on, once the preferences arrive;
  // a hidden 发现 tab sends its page back to the shelf.
  const opened = useRef(false);
  useEffect(() => {
    const value = settings.value;
    if (!value) return;
    if (!opened.current) {
      opened.current = true;
      const home = value.homeTab;
      if (home === "discover" || home === "settings") setActiveTab(home);
    }
    if (
      (value.showDiscover === false && activeTab === "discover") ||
      (value.showSubscription === false && activeTab === "subscription")
    )
      setActiveTab("bookshelf");
  }, [settings.value, activeTab, setActiveTab]);
  const backState = useRef({ activeTab, activeBook, closePending });
  backState.current = { activeTab, activeBook, closePending };
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void listenForBack([
      // An exit flush already owns the app; further presses are ignored.
      () => backState.current.closePending,
      () => {
        if (!backState.current.activeBook && !document.querySelector(OPEN_LAYER)) return false;
        // Dispatch from body: the reader ignores Escape aimed at a focused control.
        dismissWithEscape(document.body);
        // Focus restored after a dismissal would otherwise show a keyboard ring.
        requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.blur?.());
        return true;
      },
      () => {
        if (backState.current.activeTab === "bookshelf") return false;
        setActiveTab("bookshelf");
        return true;
      },
    ])
      .then((fn) => {
        if (disposed) fn();
        else cleanup = fn;
      })
      .catch((error) => console.error("Back button registration failed", error));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [setActiveTab]);
  useEffect(
    () =>
      flushWhenHidden(
        () => runtime.flush(),
        // Writers keep their own error and retry state for the visible notices.
        (error) => console.error("Saving while hidden failed", error),
      ),
    [runtime],
  );
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
      {!activeBook && (positionError || readerWriteError) && (
        <div
          role="alert"
          data-testid="reader-background-error"
          className="fixed bottom-[calc(6rem+var(--safe-bottom))] left-4 right-4 z-[60] rounded-xl bg-error-container text-error px-4 py-2 text-sm"
        >
          {t("app.progressUnsaved", { error: positionError || readerWriteError || "" })}
          <button className="ml-3 underline" onClick={runtime.retryReaderWrites}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {closeError && (
        <div role="alert" className="fixed top-0 z-[100] bg-error-container text-error p-3 w-full">
          {t("app.closeFailed", { error: closeError })}
          <button
            className="ml-3 underline"
            onClick={() => {
              if (closeRetry.current) void closeRetry.current();
              else setCloseError(null);
            }}
          >
            {closeRetry.current ? t("app.retryClose") : t("common.back")}
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
              {t("app.discardWrites")}
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
      {showLogs && <LogPage layer="z-[70]" onClose={() => setShowLogs(false)} />}
      <UpdatePrompt />
      <DisclaimerPrompt />
      <Toaster />
    </div>
  );
}
export function App({ services = tauriServices }: { services?: AppServices }) {
  const [runtime] = useState(() => new AppRuntime(services));
  // Changing the interface language renders the whole app again, so plain
  // t() calls anywhere below follow it.
  useLocale();
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
