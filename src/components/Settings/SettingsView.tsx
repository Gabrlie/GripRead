import { useEffect, useState, type CSSProperties } from "react";
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
import { native } from "../../services/transport";

type ThemeMode = ReaderPreferences["theme"];
type PaperTone = ReaderPreferences["paperTone"];
const SERIAL_DAYS: [number, string][] = [
  [0, "关闭"],
  [7, "7 天"],
  [30, "30 天"],
  [90, "90 天"],
  [180, "180 天"],
];

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
  | "server";

const THEMES: [ThemeMode, string][] = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
];

/** The app's paper tones: page, swatch, and accent colours, light then dark. */
const TONES: {
  id: PaperTone;
  name: string;
  light: [string, string, string];
  dark: [string, string, string];
}[] = [
  {
    id: "warm-tea",
    name: "柔雅暖茶",
    light: ["#fbf8f1", "#eee5d8", "#925429"],
    dark: ["#25221e", "#342e27", "#d49960"],
  },
  {
    id: "bone-white",
    name: "羊脂白",
    light: ["#faf8f5", "#eae6df", "#2a3b4c"],
    dark: ["#1f2124", "#2f333a", "#96aec6"],
  },
  {
    id: "xuan-paper",
    name: "宣纸微黄",
    light: ["#f4ede1", "#e6d8c2", "#a43d24"],
    dark: ["#252019", "#383025", "#cc745a"],
  },
  {
    id: "jade-green",
    name: "墨绿温润",
    light: ["#edf1eb", "#d5e0d3", "#225e41"],
    dark: ["#1b231d", "#28352c", "#6ab38a"],
  },
];

/** CSS variables for a tone's swatch; the `dark:` classes pick the night set. */
function toneStyle(tone: (typeof TONES)[number]) {
  const [paper, swatch, accent] = tone.light;
  const [nightPaper, nightSwatch, nightAccent] = tone.dark;
  return {
    "--tone-paper": paper,
    "--tone-swatch": swatch,
    "--tone-accent": accent,
    "--tone-paper-dark": nightPaper,
    "--tone-swatch-dark": nightSwatch,
    "--tone-accent-dark": nightAccent,
  } as CSSProperties;
}

/**
 * Legado's 我的 page for a local reader: reading statistics, the app's
 * appearance, the rules shared by all books, backup and the cloud
 * bookshelf, and about. Typography and page turning are set while
 * reading, in the reader's 界面 sheet.
 */
export function SettingsView() {
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
        <Header title="设置" subtitle="SETTINGS" />
        {state.error ? (
          <div role="alert">
            偏好设置读取失败：{state.error}
            <Button onClick={() => void store.load()}>重试</Button>
          </div>
        ) : (
          <p role="status">正在读取偏好设置…</p>
        )}
      </div>
    );
  const close = () => setPage(null);

  return (
    <div className="flex-1 flex flex-col relative w-full pt-[calc(3.5rem+var(--safe-top))] pb-[calc(5rem+var(--safe-bottom))] md:pb-8 bg-surface min-w-0">
      <Header title="设置" subtitle="SETTINGS" />
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 md:px-8 space-y-4 pt-3 pb-6">
        {state.error && (
          <div role="alert" className="rounded-xl bg-error-container text-error p-3 text-xs">
            偏好设置保存失败：{state.error}
            <Button size="sm" variant="outline" onClick={() => store.retry()}>
              重试
            </Button>
          </div>
        )}

        <button
          type="button"
          aria-label="阅读记录"
          onClick={() => setPage("records")}
          className="w-full rounded-xl bg-surface-container p-4 text-left hover:bg-surface-container-high transition-colors"
        >
          <span className="flex items-center justify-between mb-2 text-xs text-secondary">
            <span className="flex items-center gap-1.5">
              <Icon name="insights" size={15} className="text-primary" />
              阅读概览
            </span>
            <span className="flex items-center gap-0.5 text-primary">
              阅读记录
              <Icon name="chevron_right" size={14} />
            </span>
          </span>
          <span className="grid grid-cols-3 gap-2 text-center">
            {[
              [stats ? formatDuration(stats.todaySeconds) : "—", "今日阅读"],
              [stats ? formatDuration(stats.totalSeconds) : "—", "累计阅读"],
              [library.loading ? "—" : `${library.books.length} 本`, "藏书"],
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

        <PageSection title="外观">
          <div className="p-4 space-y-4">
            <div className="space-y-2">
              <span className="text-sm">界面主题</span>
              <div
                role="radiogroup"
                aria-label="界面主题"
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
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-sm">纸张色调</span>
              <div role="radiogroup" aria-label="纸张色调" className="grid grid-cols-4 gap-2">
                {TONES.map((tone) => {
                  const selected = value.paperTone === tone.id;
                  return (
                    <button
                      key={tone.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => store.set({ paperTone: tone.id })}
                      style={toneStyle(tone)}
                      className={`flex flex-col items-center gap-1 rounded-xl p-1.5 border border-black/5 dark:border-white/10 bg-[var(--tone-paper)] dark:bg-[var(--tone-paper-dark)] text-[var(--tone-accent)] dark:text-[var(--tone-accent-dark)] ${selected ? "ring-2 ring-[var(--tone-accent)] dark:ring-[var(--tone-accent-dark)]" : ""}`}
                    >
                      <span className="w-full h-7 rounded-lg flex items-center justify-center bg-[var(--tone-swatch)] dark:bg-[var(--tone-swatch-dark)]">
                        {selected && <Icon name="check" size={15} />}
                      </span>
                      <span className="text-[11px]">{tone.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                OLED 纯黑
                <span className="block text-[11px] text-secondary">深色模式使用纯黑背景</span>
              </span>
              <Switch
                aria-label="OLED 纯黑背景"
                checked={value.oledBlack}
                onCheckedChange={(oledBlack) => store.set({ oledBlack })}
              />
            </label>
          </div>
        </PageSection>

        <PageSection title="书架">
          <div className="p-4 space-y-2">
            <span className="text-sm">
              连载判定
              <span className="block text-[11px] text-secondary">
                这段时间内更新过的网络书籍读到最后也不移入读完
              </span>
            </span>
            <div
              role="radiogroup"
              aria-label="连载判定"
              className="grid grid-cols-5 gap-1.5 bg-surface-container p-1 rounded-lg"
            >
              {SERIAL_DAYS.map(([days, label]) => (
                <button
                  key={days}
                  type="button"
                  role="radio"
                  aria-checked={(value.serialDays ?? 30) === days}
                  onClick={() => store.set({ serialDays: days })}
                  className={`h-8 rounded-md text-xs ${(value.serialDays ?? 30) === days ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center justify-between gap-3 pt-2 text-sm">
              <span>
                自动更新
                <span className="block text-[11px] text-secondary">
                  打开应用后首次进入书架，或离开半小时后回来时，更新网络书籍的目录
                </span>
              </span>
              <Switch
                aria-label="自动更新"
                checked={value.autoUpdateShelf ?? true}
                onCheckedChange={(autoUpdateShelf) => store.set({ autoUpdateShelf })}
              />
            </label>
          </div>
        </PageSection>

        <PageSection title="规则">
          <PageLink
            icon="public"
            label="书源管理"
            detail="导入、编辑、校验书源"
            onClick={() => setPage("sources")}
          />
          <PageLink
            icon="find_replace"
            label="替换净化"
            detail="替换或删除正文中的文字，所有书共用"
            onClick={() => setPage("replace")}
          />
          <PageLink
            icon="toc_rule"
            label="TXT目录规则"
            detail="识别章节标题的规则"
            onClick={() => setPage("toc")}
          />
        </PageSection>

        {/* The web version is the server: it neither backs up nor syncs. */}
        {native && (
          <PageSection title="备份与云端">
            <PageLink
              icon="sync"
              label="服务器"
              detail={
                server?.connected
                  ? server.lastError
                    ? `同步失败：${server.lastError}`
                    : `已连接 ${server.address.replace(/^https?:\/\//, "")}`
                  : "连接自建的 GripRead 服务器，代替 WebDAV 同步"
              }
              onClick={() => setPage("server")}
            />
            <PageLink
              icon="cloud"
              label="备份与恢复"
              detail={
                !webdav
                  ? undefined
                  : !webdav.configured
                    ? "WebDAV 未设置，可备份到文件"
                    : webdav.lastError
                      ? `自动备份失败：${webdav.lastError}`
                      : webdav.lastBackupAt
                        ? `上次备份 ${formatTime(webdav.lastBackupAt)}`
                        : "尚未备份"
              }
              onClick={() => setPage("backup")}
            />
            <PageLink
              icon="folder_open"
              label="云书架"
              detail="在 WebDAV 上存放书籍文件，一键上传、完整下载"
              onClick={() => setPage("cloud")}
            />
          </PageSection>
        )}

        <PageSection title="更多">
          {!native && (
            <PageLink icon="person" label="服务器账号" onClick={() => setPage("account")} />
          )}
          <PageLink icon="public" label="网络设置" onClick={() => setPage("network")} />
          <PageLink icon="storage" label="数据管理" onClick={() => setPage("cache")} />
          <PageLink icon="bug_report" label="日志" onClick={() => setPage("logs")} />
          <PageLink
            icon="info"
            label="关于"
            detail={`手不释卷 · GripRead ${APP_VERSION}`}
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
      {page === "cloud" && <CloudShelfPage onClose={close} onSetUp={() => setPage("backup")} />}
    </div>
  );
}
