import { useEffect, useState } from "react";
import { Header } from "../Layout/Header";
import { PageLink, PageSection } from "../Layout/FullPage";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useLibrary, useRuntime, useSettings } from "../../application/runtime";
import { useApp } from "../../context/AppContext";
import { formatDuration, localDay } from "../../application/reading-time";
import type {
  LibraryBook,
  ReaderPreferences,
  ReadingStats,
  SyncServerStatus,
  WebDavSettings,
} from "../../types/generated";
import { BookDetailPage } from "../Bookshelf/BookDetailPage";
import { ReadingRecordsPage } from "../Bookshelf/ReadingRecordsPage";
import { ReplaceRulesPage } from "../Rules/ReplaceRulesPage";
import { TocRulesPage } from "../Rules/TocRulesPage";
import { SourceManagePage } from "../Sources/SourceManagePage";
import { BackupPage } from "../Cloud/BackupPage";
import { CloudShelfPage } from "../Cloud/CloudShelfPage";
import { formatTime } from "../Cloud/format";
import { APP_VERSION, AboutPage } from "./AboutPage";
import { LogPage } from "./LogPage";
import { DataManagerPage } from "./DataManagerPage";
import { NetworkSettingsPage } from "./NetworkSettingsPage";
import { ServerAccountPage } from "./ServerAccountPage";
import { ServerSyncPage } from "./ServerSyncPage";
import { TranslationSettingsPage } from "./TranslationSettingsPage";
import { AppearancePage } from "./AppearancePage";
import { FeedManagePage } from "../Rss/FeedManagePage";
import { RssSettingsPage } from "../Rss/RssSettingsPage";
import { StyleSwatch, choose, chosenStyle, pinnedChoices } from "./interface-styles";
import { native } from "../../services/transport";
import { useT, type MessageKey } from "../../i18n";

type ThemeMode = ReaderPreferences["theme"];
const SERIAL_DAYS = [0, 7, 30, 90, 180];

type Page =
  | "records"
  | "sources"
  | "replace"
  | "toc"
  | "backup"
  | "cloud"
  | "about"
  | "logs"
  | "cache"
  | "network"
  | "account"
  | "server"
  | "translation"
  | "appearance"
  | "feeds"
  | "rss";

const THEMES: [ThemeMode, MessageKey][] = [
  ["system", "common.followSystem"],
  ["light", "settings.theme.light"],
  ["dark", "settings.theme.dark"],
];

/**
 * Legado's 我的 page for a local reader: reading statistics, the app's
 * appearance, the rules shared by all books, backup and the cloud
 * bookshelf, and about. Typography and page turning are set while
 * reading, in the reader's 界面 sheet.
 */
export function SettingsView() {
  const t = useT();
  const runtime = useRuntime();
  const { openReader } = useApp();
  const { state, store } = useSettings();
  const { state: library } = useLibrary();
  const [page, setPage] = useState<Page | null>(null);
  const [detail, setDetail] = useState<LibraryBook | null>(null);
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [webdav, setWebdav] = useState<WebDavSettings | null>(null);
  const [server, setServer] = useState<SyncServerStatus | null>(null);
  useEffect(() => {
    if (page !== null) return;
    let cancelled = false;
    if (native)
      runtime.services.sync.getServer().then(
        (value) => !cancelled && setServer(value),
        () => undefined,
      );
    runtime.services.library.readingStats(localDay()).then(
      (value) => !cancelled && setStats(value),
      () => undefined,
    );
    runtime.services.sync.getWebDav().then(
      (value) => !cancelled && setWebdav(value),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [page, runtime.services]);

  const value = state.value;
  if (!value)
    return (
      <div className="pt-20 px-4">
        <Header title={t("settings.title")} subtitle="SETTINGS" />
        {state.error ? (
          <div role="alert">
            {t("settings.loadFailed", { error: state.error })}
            <Button onClick={() => void store.load()}>{t("common.retry")}</Button>
          </div>
        ) : (
          <p role="status">{t("settings.loading")}</p>
        )}
      </div>
    );
  const close = () => setPage(null);

  return (
    <div className="flex-1 flex flex-col relative w-full pt-[calc(3.5rem+var(--safe-top))] pb-[calc(5rem+var(--safe-bottom))] md:pb-8 bg-surface min-w-0">
      <Header title={t("settings.title")} subtitle="SETTINGS" />
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 md:px-8 space-y-4 pt-3 pb-6">
        {state.error && (
          <div role="alert" className="rounded-xl bg-error-container text-error p-3 text-xs">
            {t("settings.saveFailed", { error: state.error })}
            <Button size="sm" variant="outline" onClick={() => store.retry()}>
              {t("common.retry")}
            </Button>
          </div>
        )}

        <button
          type="button"
          aria-label={t("settings.records")}
          onClick={() => setPage("records")}
          className="w-full rounded-xl bg-surface-container p-4 text-left hover:bg-surface-container-high transition-colors"
        >
          <span className="flex items-center justify-between mb-2 text-xs text-secondary">
            <span className="flex items-center gap-1.5">
              <Icon name="insights" size={15} className="text-primary" />
              {t("settings.overview")}
            </span>
            <span className="flex items-center gap-0.5 text-primary">
              {t("settings.records")}
              <Icon name="chevron_right" size={14} />
            </span>
          </span>
          <span className="grid grid-cols-3 gap-2 text-center">
            {[
              [stats ? formatDuration(stats.todaySeconds) : "—", t("settings.today")],
              [stats ? formatDuration(stats.totalSeconds) : "—", t("settings.total")],
              [
                library.loading ? "—" : t("common.books", { count: library.books.length }),
                t("settings.library"),
              ],
            ].map(([figure, label]) => (
              <span key={label} className="flex flex-col py-1">
                <span className="text-base font-semibold text-on-surface leading-tight">
                  {figure}
                </span>
                <span className="text-[11px] text-secondary">{label}</span>
              </span>
            ))}
          </span>
        </button>

        <PageSection title={t("settings.appearance")}>
          <div className="p-4 space-y-4">
            <div className="space-y-2">
              <span className="text-sm">{t("settings.theme")}</span>
              <div
                role="radiogroup"
                aria-label={t("settings.theme")}
                className="grid grid-cols-3 gap-1.5 bg-surface-container p-1 rounded-lg"
              >
                {THEMES.map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={value.theme === mode}
                    onClick={() => store.set({ theme: mode })}
                    className={`h-8 rounded-md text-xs ${value.theme === mode ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
                  >
                    {t(label)}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-sm">{t("settings.interfaceStyle")}</span>
              <div
                role="radiogroup"
                aria-label={t("settings.interfaceStyle")}
                className="grid grid-cols-4 gap-2"
              >
                {pinnedChoices(value).map((choice) => (
                  <StyleSwatch
                    key={choice.id}
                    choice={choice}
                    selected={chosenStyle(value) === choice.id}
                    onChoose={() => store.set(choose(choice))}
                  />
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                {t("settings.oled")}
                <span className="block text-[11px] text-secondary">{t("settings.oled.note")}</span>
              </span>
              <Switch
                aria-label={t("settings.oled.label")}
                checked={value.oledBlack}
                onCheckedChange={(oledBlack) => store.set({ oledBlack })}
              />
            </label>
          </div>
          <PageLink
            icon="tune"
            label={t("settings.moreAppearance")}
            detail={t("settings.moreAppearance.note")}
            onClick={() => setPage("appearance")}
          />
        </PageSection>

        <PageSection title={t("settings.shelf")}>
          <div className="p-4 space-y-2">
            <span className="text-sm">
              {t("settings.serial")}
              <span className="block text-[11px] text-secondary">{t("settings.serial.note")}</span>
            </span>
            <div
              role="radiogroup"
              aria-label={t("settings.serial")}
              className="grid grid-cols-5 gap-1.5 bg-surface-container p-1 rounded-lg"
            >
              {SERIAL_DAYS.map((days) => (
                <button
                  key={days}
                  type="button"
                  role="radio"
                  aria-checked={(value.serialDays ?? 30) === days}
                  onClick={() => store.set({ serialDays: days })}
                  className={`h-8 rounded-md text-xs ${(value.serialDays ?? 30) === days ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
                >
                  {days ? t("common.days", { count: days }) : t("common.off")}
                </button>
              ))}
            </div>
            <label className="flex items-center justify-between gap-3 pt-2 text-sm">
              <span>
                {t("settings.autoUpdate")}
                <span className="block text-[11px] text-secondary">
                  {t("settings.autoUpdate.note")}
                </span>
              </span>
              <Switch
                aria-label={t("settings.autoUpdate")}
                checked={value.autoUpdateShelf ?? true}
                onCheckedChange={(autoUpdateShelf) => store.set({ autoUpdateShelf })}
              />
            </label>
          </div>
        </PageSection>

        <PageSection title={t("settings.rules")}>
          <PageLink
            icon="public"
            label={t("settings.sources")}
            detail={t("settings.sources.note")}
            onClick={() => setPage("sources")}
          />
          <PageLink
            icon="find_replace"
            label={t("settings.replace")}
            detail={t("settings.replace.note")}
            onClick={() => setPage("replace")}
          />
          <PageLink
            icon="toc_rule"
            label={t("settings.toc")}
            detail={t("settings.toc.note")}
            onClick={() => setPage("toc")}
          />
          <PageLink
            icon="translate"
            label={t("translation.title")}
            detail={t("translation.note")}
            onClick={() => setPage("translation")}
          />
        </PageSection>

        <PageSection title={t("nav.feeds")}>
          <PageLink
            icon="rss_feed"
            label={t("rss.settings")}
            detail={t("rss.settings.note")}
            onClick={() => setPage("rss")}
          />
          <PageLink
            icon="tune"
            label={t("rss.manage")}
            detail={t("settings.feeds.note")}
            onClick={() => setPage("feeds")}
          />
        </PageSection>

        {/* The web version is the server: it neither backs up nor syncs. */}
        {native && (
          <PageSection title={t("settings.cloud")}>
            <PageLink
              icon="sync"
              label={t("settings.server")}
              detail={
                server?.connected
                  ? server.lastError
                    ? t("settings.server.failed", { error: server.lastError })
                    : t("settings.server.connected", {
                        address: server.address.replace(/^https?:\/\//, ""),
                      })
                  : t("settings.server.note")
              }
              onClick={() => setPage("server")}
            />
            <PageLink
              icon="cloud"
              label={t("settings.backup")}
              detail={
                !webdav
                  ? undefined
                  : !webdav.configured
                    ? t("settings.backup.unset")
                    : webdav.lastError
                      ? t("settings.backup.failed", { error: webdav.lastError })
                      : webdav.lastBackupAt
                        ? t("settings.backup.last", { time: formatTime(webdav.lastBackupAt) })
                        : t("settings.backup.never")
              }
              onClick={() => setPage("backup")}
            />
            <PageLink
              icon="folder_open"
              label={t("settings.cloudShelf")}
              detail={t("settings.cloudShelf.note")}
              onClick={() => setPage("cloud")}
            />
          </PageSection>
        )}

        <PageSection title={t("settings.more")}>
          {!native && (
            <PageLink
              icon="person"
              label={t("settings.account")}
              onClick={() => setPage("account")}
            />
          )}
          <PageLink
            icon="public"
            label={t("settings.network")}
            onClick={() => setPage("network")}
          />
          <PageLink icon="storage" label={t("settings.data")} onClick={() => setPage("cache")} />
          <PageLink icon="bug_report" label={t("settings.logs")} onClick={() => setPage("logs")} />
          <PageLink
            icon="info"
            label={t("settings.about")}
            detail={t("settings.about.note", { version: APP_VERSION })}
            onClick={() => setPage("about")}
          />
        </PageSection>
      </main>

      {page === "records" && <ReadingRecordsPage onClose={close} onOpenBook={setDetail} />}
      {detail && (
        <BookDetailPage
          book={
            [...library.books, ...library.removedBooks].find(
              (item) => item.book.id === detail.book.id,
            ) ?? detail
          }
          onOpen={(target) => {
            const book = detail;
            setDetail(null);
            close();
            openReader(book, target);
          }}
          onClose={() => setDetail(null)}
        />
      )}
      {page === "sources" && (
        <SourceManagePage service={runtime.services.sources} onClose={close} />
      )}
      {page === "replace" && (
        <ReplaceRulesPage service={runtime.services.reader} onClose={close} backCloses />
      )}
      {page === "toc" && <TocRulesPage service={runtime.services.reader} onClose={close} />}
      {page === "backup" && <BackupPage onClose={close} />}
      {page === "about" && <AboutPage onClose={close} />}
      {page === "account" && <ServerAccountPage onClose={close} />}
      {page === "server" && <ServerSyncPage onClose={close} />}
      {page === "logs" && <LogPage onClose={close} />}
      {page === "cache" && <DataManagerPage onClose={close} />}
      {page === "network" && <NetworkSettingsPage onClose={close} />}
      {page === "translation" && <TranslationSettingsPage onClose={close} />}
      {page === "appearance" && <AppearancePage onClose={close} />}
      {page === "rss" && <RssSettingsPage onClose={close} />}
      {page === "feeds" && <FeedManagePage onClose={close} />}
      {page === "cloud" && <CloudShelfPage onClose={close} onSetUp={() => setPage("backup")} />}
    </div>
  );
}
