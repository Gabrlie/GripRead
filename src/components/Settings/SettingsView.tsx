import { useEffect, useState } from "react";
import { Header } from "../Layout/Header";
import { PageLink, PageSection } from "../Layout/FullPage";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useLibrary, useRuntime, useSettings } from "../../application/runtime";
import { useApp } from "../../context/AppContext";
import { formatDuration, localDay } from "../../application/reading-time";
import type { ReaderPreferences, ReadingStats, WebDavSettings } from "../../types/generated";
import { ReadingRecordsPage } from "../Bookshelf/ReadingRecordsPage";
import { ReplaceRulesPage } from "../Rules/ReplaceRulesPage";
import { TocRulesPage } from "../Rules/TocRulesPage";
import { BackupPage } from "../Cloud/BackupPage";
import { CloudShelfPage } from "../Cloud/CloudShelfPage";
import { formatTime } from "../Cloud/format";

type ThemeMode = ReaderPreferences["theme"];
type PaperTone = ReaderPreferences["paperTone"];
type Page = "records" | "replace" | "toc" | "backup" | "cloud";

const THEMES: [ThemeMode, string][] = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
];

/** The app's paper tones: page colour, swatch colour, and accent. */
const TONES: { id: PaperTone; name: string; paper: string; swatch: string; accent: string }[] = [
  { id: "warm-tea", name: "柔雅暖茶", paper: "#fbf8f1", swatch: "#eee5d8", accent: "#925429" },
  { id: "bone-white", name: "羊脂白", paper: "#faf8f5", swatch: "#eae6df", accent: "#2a3b4c" },
  { id: "xuan-paper", name: "宣纸微黄", paper: "#f4ede1", swatch: "#e6d8c2", accent: "#a43d24" },
  { id: "jade-green", name: "墨绿温润", paper: "#edf1eb", swatch: "#d5e0d3", accent: "#225e41" },
];

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
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [webdav, setWebdav] = useState<WebDavSettings | null>(null);
  useEffect(() => {
    if (page !== null) return;
    let cancelled = false;
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
                {TONES.map((tone) => (
                  <button
                    key={tone.id}
                    type="button"
                    role="radio"
                    aria-checked={value.paperTone === tone.id}
                    onClick={() => store.set({ paperTone: tone.id })}
                    className="flex flex-col items-center gap-1 rounded-xl p-1.5 border border-black/5"
                    style={{
                      background: tone.paper,
                      boxShadow:
                        value.paperTone === tone.id ? `0 0 0 2px ${tone.accent}` : undefined,
                    }}
                  >
                    <span
                      className="w-full h-7 rounded-lg flex items-center justify-center"
                      style={{ background: tone.swatch, color: tone.accent }}
                    >
                      {value.paperTone === tone.id && <Icon name="check" size={15} />}
                    </span>
                    <span className="text-[11px]" style={{ color: tone.accent }}>
                      {tone.name}
                    </span>
                  </button>
                ))}
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

        <PageSection title="规则">
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

        <PageSection title="备份与云端">
          <PageLink
            icon="cloud"
            label="备份与恢复"
            detail={
              !webdav
                ? undefined
                : !webdav.url
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

        <PageSection title="关于">
          <div className="flex items-center gap-3 px-4 py-3">
            <Icon name="auto_stories" size={18} className="text-primary shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-sm">手不释卷 · GripRead</span>
              <span className="block text-[11px] text-secondary">
                v0.1.0 · 本地优先的小说阅读器
              </span>
            </span>
          </div>
        </PageSection>

        <p role="status" className="text-xs text-secondary text-center">
          {state.saving
            ? "正在保存偏好设置…"
            : state.error
              ? "偏好设置尚未保存"
              : "偏好设置已保存到本地"}
        </p>
      </main>

      {page === "records" && (
        <ReadingRecordsPage
          onClose={close}
          onOpenBook={(book) => {
            close();
            openReader(book);
          }}
        />
      )}
      {page === "replace" && (
        <ReplaceRulesPage service={runtime.services.reader} onClose={close} backCloses />
      )}
      {page === "toc" && <TocRulesPage service={runtime.services.reader} onClose={close} />}
      {page === "backup" && <BackupPage onClose={close} />}
      {page === "cloud" && <CloudShelfPage onClose={close} onSetUp={() => setPage("backup")} />}
    </div>
  );
}
