import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { useRuntime } from "../../application/runtime";
import { defaultDeviceName } from "../../application/device";
import type {
  BackupPreview,
  BackupSource,
  RemoteBackup,
  RestoreCategory,
  RestoreReport,
  SaveWebDavRequest,
  WebDavCheck,
  WebDavSettings,
} from "../../types/generated";
import { ServerPausedNote } from "./ServerPausedNote";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { reportError, toast } from "../ui/toast";
import { Switch } from "../ui/switch";
import { describeError, formatSize, formatTime } from "./format";
import { t } from "../../i18n";

/** Legado's 恢复忽略列表 entries for GripRead's backup contents. */
export const restoreCategories = (): [RestoreCategory, string, string][] => [
  ["reading-settings", t("backup.cat.reading"), t("backup.cat.reading.note")],
  ["theme", t("backup.cat.theme"), t("backup.cat.theme.note")],
  ["shelf-layout", t("backup.cat.shelf"), t("backup.cat.shelf.note")],
  ["replace-rules", t("settings.replace"), ""],
  ["toc-rules", t("reader.tool.tocRules"), ""],
  ["groups", t("detail.group"), t("backup.cat.groups.note")],
  ["book-info", t("detail.info"), t("backup.cat.books.note")],
  ["progress", t("detail.progress"), ""],
  ["bookmarks", t("contents.bookmarks"), ""],
  ["reading-time", t("detail.readingTime"), ""],
  ["sources", t("settings.sources"), t("backup.cat.sources.note")],
  ["online-books", t("downloads.books"), t("backup.cat.online.note")],
  ["rss", t("backup.cat.rss"), t("backup.cat.rss.note")],
];

type Draft = Omit<SaveWebDavRequest, "password"> & { password: string };

function draftOf(settings: WebDavSettings): Draft {
  return {
    url: settings.url,
    username: settings.username,
    password: settings.password,
    folder: settings.folder,
    deviceName: settings.deviceName,
    autoBackup: settings.autoBackup,
    syncProgress: settings.syncProgress,
    syncProgressPlus: settings.syncProgressPlus,
    autoSyncBookInfo: settings.autoSyncBookInfo ?? false,
    restoreIgnore: settings.restoreIgnore,
  };
}

/**
 * Saves switches (同步排除 among them) with the account as saved, never
 * the typed but unsaved fields.
 */
export function switchRequest(
  settings: WebDavSettings,
  patch: Partial<SaveWebDavRequest>,
): SaveWebDavRequest {
  const from = { ...draftOf(settings), ...patch };
  return {
    ...from,
    url: from.url.trim(),
    username: from.username.trim(),
    deviceName: from.deviceName.trim() || defaultDeviceName(),
  };
}

/**
 * Legado's 备份与恢复 with WebDAV: the account (an empty address uses 坚果云),
 * 子文件夹 and 设备名称, progress sync, the local backup folder, backing up
 * to WebDAV or a file, and restoring from either or from a recovery point,
 * skipping what the 恢复忽略列表 names. A backup holds shelf records,
 * progress, bookmarks, rules, and settings, never books.
 */
export function BackupPage({ onClose }: { onClose: () => void }) {
  const runtime = useRuntime();
  const sync = runtime.services.sync;
  const [settings, setSettings] = useState<WebDavSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [latency, setLatency] = useState<WebDavCheck | null>(null);
  const [backups, setBackups] = useState<RemoteBackup[] | null>(null);
  const [points, setPoints] = useState<string[]>([]);
  const [ignoring, setIgnoring] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [restoring, setRestoring] = useState<{
    source: BackupSource;
    label: string;
    preview: BackupPreview;
  } | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const deviceFallback = defaultDeviceName();

  const apply = (value: WebDavSettings) => {
    setSettings(value);
    setDraft(draftOf(value));
  };
  const load = useCallback(async () => {
    const value = await sync.getWebDav();
    setSettings(value);
    setDraft(draftOf(value));
    setPoints(await sync.listRecoveryPoints().catch(() => []));
  }, [sync]);
  useEffect(() => {
    void load().catch(reportError);
  }, [load]);

  const run = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label);
    try {
      const text = await work();
      if (text) toast(text);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(null);
    }
  };
  if (!settings || !draft)
    return (
      <FullPage label={t("settings.backup")} onClose={onClose}>
        <p role="status" className="text-sm text-secondary px-1">
          {t("common.loading")}
        </p>
      </FullPage>
    );

  const request = (from: Draft = draft): SaveWebDavRequest => ({
    ...from,
    url: from.url.trim(),
    username: from.username.trim(),
    password: from.password,
    deviceName: from.deviceName.trim() || deviceFallback,
  });
  const accountChanged =
    draft.url.trim() !== settings.url ||
    draft.username.trim() !== settings.username ||
    draft.password !== settings.password ||
    draft.folder.trim() !== settings.folder ||
    draft.deviceName.trim() !== settings.deviceName;
  /** Switches save at once, without the typed but unsaved account fields. */
  const saveSwitch = (patch: Partial<Draft>) =>
    run("switch", async () => {
      const saved = await sync.saveWebDav(switchRequest(settings, patch));
      setSettings(saved);
      // Untouched account fields follow what was saved (a filled-in device
      // name), so a switch never leaves 保存 lit.
      setDraft(accountChanged ? { ...draft, ...patch } : { ...draftOf(saved), ...patch });
    });
  const configured = settings.configured;
  const preview = (source: BackupSource, label: string) =>
    run("preview", async () => {
      setRestoring({ source, label, preview: await sync.previewBackup(source) });
    });
  const field = (
    label: string,
    key: "url" | "username" | "folder" | "deviceName",
    placeholder: string,
    extra?: Partial<ComponentProps<typeof Input>>,
  ) => (
    <label className="block space-y-1 text-xs text-secondary">
      {label}
      <Input
        value={draft[key]}
        placeholder={placeholder}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        {...extra}
      />
    </label>
  );
  const slowWarning = latency?.slow && (
    <p className="text-[11px] text-error">{t("backup.slow", { ms: latency.latencyMs })}</p>
  );

  return (
    <FullPage label={t("settings.backup")} onClose={onClose}>
      <ServerPausedNote />
      <PageSection title={t("backup.account")}>
        <div className="p-4 space-y-3">
          {field(t("backup.url"), "url", t("backup.url.placeholder"), { inputMode: "url" })}
          {field(t("backup.username"), "username", "", { autoComplete: "username" })}
          <label className="block space-y-1 text-xs text-secondary">
            {t("network.proxy.password")}
            <span className="relative block">
              <Input
                type={showPassword ? "text" : "password"}
                value={draft.password}
                autoComplete="current-password"
                placeholder={t("backup.password.placeholder")}
                className="pr-10"
                onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              />
              <button
                type="button"
                aria-label={showPassword ? t("backup.hidePassword") : t("backup.showPassword")}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center text-secondary"
                onClick={() => setShowPassword((shown) => !shown)}
              >
                <Icon name={showPassword ? "visibility_off" : "visibility"} size={16} />
              </button>
            </span>
          </label>
          {field(t("backup.folder"), "folder", "GripRead")}
          {field(t("backup.device"), "deviceName", deviceFallback)}
          <p className="text-[11px] text-secondary">{t("backup.account.note")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!(draft.url.trim() || draft.username.trim()) || busy !== null}
              onClick={() =>
                run("test", async () => {
                  const result = await sync.testWebDav(request());
                  setLatency(result);
                  return t("backup.connected", { ms: result.latencyMs });
                })
              }
            >
              {busy === "test" ? t("network.testing") : t("backup.test")}
            </Button>
            <Button
              size="sm"
              disabled={!accountChanged || busy !== null}
              onClick={() =>
                run("save", async () => {
                  apply(await sync.saveWebDav(request()));
                  return t("backup.saved");
                })
              }
            >
              {t("common.save")}
            </Button>
          </div>
          {slowWarning}
        </div>
      </PageSection>

      <PageSection title={t("detail.sync")}>
        <div className="p-4 space-y-4">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t("backup.syncProgress")}
              <span className="block text-[11px] text-secondary">
                {t("backup.syncProgress.note")}
              </span>
            </span>
            <Switch
              aria-label={t("backup.syncProgress")}
              checked={draft.syncProgress}
              disabled={busy !== null}
              onCheckedChange={(syncProgress) =>
                saveSwitch({
                  syncProgress,
                  syncProgressPlus: syncProgress && draft.syncProgressPlus,
                })
              }
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t("backup.syncPlus")}
              <span className="block text-[11px] text-secondary">{t("backup.syncPlus.note")}</span>
            </span>
            <Switch
              aria-label={t("backup.syncPlus")}
              checked={draft.syncProgressPlus}
              disabled={busy !== null || !draft.syncProgress}
              onCheckedChange={(syncProgressPlus) => saveSwitch({ syncProgressPlus })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{t("backup.autoBookInfo")}</span>
            <Switch
              aria-label={t("backup.autoBookInfo")}
              checked={draft.autoSyncBookInfo ?? false}
              disabled={busy !== null}
              onCheckedChange={(autoSyncBookInfo) => saveSwitch({ autoSyncBookInfo })}
            />
          </label>
          {slowWarning}
          {!configured && <p className="text-[11px] text-secondary">{t("backup.needsAccount")}</p>}
        </div>
      </PageSection>

      <PageSection title={t("backup.section")}>
        <div className="p-4 space-y-3">
          <p className="text-xs text-secondary">{t("backup.noBooks")}</p>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0">
              {t("backup.localFolder")}
              <span className="block text-[11px] text-secondary truncate">
                {settings.localFolder ?? t("backup.localFolder.none")}
              </span>
            </span>
            <span className="flex gap-1 shrink-0">
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  run("folder", async () => {
                    apply(await sync.setBackupFolder());
                  })
                }
              >
                {t("backup.choose")}
              </Button>
              {settings.localFolder && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    run("folder", async () => {
                      apply(await sync.setBackupFolder(true));
                    })
                  }
                >
                  {t("data.clear")}
                </Button>
              )}
            </span>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t("backup.auto")}
              <span className="block text-[11px] text-secondary">{t("backup.auto.note")}</span>
            </span>
            <Switch
              aria-label={t("backup.auto")}
              checked={draft.autoBackup}
              disabled={busy !== null}
              onCheckedChange={(autoBackup) => saveSwitch({ autoBackup })}
            />
          </label>
          {settings.lastBackupAt && (
            <p className="text-xs">
              {t("backup.last", { time: formatTime(settings.lastBackupAt) })}
            </p>
          )}
          {settings.lastError && (
            <p className="text-xs text-error break-words">
              {t("backup.lastFailed", { error: describeError(settings.lastError) })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!configured || accountChanged || busy !== null}
              onClick={() =>
                run("backup", async () => {
                  const backup = await sync.backupNow();
                  await load();
                  if (backups) setBackups(await sync.listBackups());
                  return t("backup.done", { name: backup.name });
                })
              }
            >
              <Icon name="cloud" size={14} />
              {busy === "backup" ? t("backup.busy") : t("backup.toWebdav")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run("export", async () =>
                  (await sync.exportBackupFile()) ? t("backup.fileSaved") : undefined,
                )
              }
            >
              <Icon name="save" size={14} />
              {t("backup.toFile")}
            </Button>
          </div>
        </div>
      </PageSection>

      <PageSection title={t("shelf.bin.restore")}>
        <div className="p-4 space-y-3">
          <p className="text-xs text-secondary">{t("backup.restoreNote")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!configured || busy !== null}
              onClick={() =>
                run("list", async () => {
                  setBackups(await sync.listBackups());
                })
              }
            >
              <Icon name="cloud" size={14} />
              {busy === "list" ? t("common.loading") : t("backup.fromWebdav")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run("file", async () => {
                  const source = await sync.pickBackupFile();
                  if (source)
                    setRestoring({
                      source,
                      label: t("backup.chosenFile"),
                      preview: await sync.previewBackup(source),
                    });
                })
              }
            >
              <Icon name="folder_open" size={14} />
              {t("backup.fromFile")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIgnoring(true)}>
              {t("backup.exclusions")}
              {settings.restoreIgnore.length > 0 && (
                <span className="ml-1 text-[11px] text-secondary">
                  {t("backup.exclusionCount", { count: settings.restoreIgnore.length })}
                </span>
              )}
            </Button>
          </div>
          {backups && (
            <ul aria-label={t("backup.remote")} className="space-y-1">
              {backups.length === 0 && (
                <li className="text-xs text-secondary py-2">{t("backup.remoteNone")}</li>
              )}
              {backups.map((backup) => (
                <li
                  key={backup.name}
                  className="flex items-center gap-2 rounded-lg bg-surface-container px-3 py-2"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">
                      {formatTime(backup.modified)}
                      <span className="ml-2 text-[11px] text-secondary">
                        {backup.automatic ? t("detail.automatic") : t("backup.manual")} ·{" "}
                        {formatSize(backup.size)}
                      </span>
                    </span>
                    <span className="block text-[11px] text-secondary truncate">
                      {backup.device ? t("backup.from", { device: backup.device }) : backup.name}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      preview({ kind: "remote", name: backup.name }, formatTime(backup.modified))
                    }
                  >
                    {t("shelf.bin.restore")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("backup.delete", { name: backup.name })}
                    className="h-8 w-8 text-secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      run("delete", async () => {
                        await sync.deleteBackup(backup.name);
                        setBackups(await sync.listBackups());
                        return t("records.deleted");
                      })
                    }
                  >
                    <Icon name="delete" size={15} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {points.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-secondary">{t("backup.points")}</p>
              {points.map((point) => {
                const time = Number(point.replace(/\D/g, ""));
                return (
                  <div
                    key={point}
                    className="flex items-center gap-2 rounded-lg bg-surface-container px-3 py-2"
                  >
                    <span className="flex-1 text-sm">{formatTime(time)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => preview({ kind: "recovery", name: point }, formatTime(time))}
                    >
                      {t("shelf.bin.restore")}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("backup.deletePoint", { time: formatTime(time) })}
                      className="h-8 w-8 text-secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        run("delete", async () => {
                          await sync.deleteRecoveryPoint(point);
                          setPoints(await sync.listRecoveryPoints());
                          return t("records.deleted");
                        })
                      }
                    >
                      <Icon name="delete" size={15} />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PageSection>

      {ignoring && (
        <Dialog open onOpenChange={(open) => !open && setIgnoring(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm max-h-[80dvh] overflow-y-auto p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("backup.exclusions")}
              </DialogTitle>
              <DialogDescription>{t("backup.exclusions.note")}</DialogDescription>
            </DialogHeader>
            <ul className="space-y-1">
              {restoreCategories().map(([category, label, note]) => (
                <li key={category}>
                  <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface-container">
                    <span>
                      {label}
                      {note && <span className="block text-[11px] text-secondary">{note}</span>}
                    </span>
                    <Switch
                      aria-label={t("backup.ignore", { label })}
                      checked={draft.restoreIgnore.includes(category)}
                      disabled={busy !== null}
                      onCheckedChange={(ignore) =>
                        saveSwitch({
                          restoreIgnore: ignore
                            ? [...draft.restoreIgnore, category]
                            : draft.restoreIgnore.filter((item) => item !== category),
                        })
                      }
                    />
                  </label>
                </li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>
      )}

      {restoring && (
        <Dialog open onOpenChange={(open) => !open && setRestoring(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("backup.restoreTitle")}
              </DialogTitle>
              <DialogDescription>
                {restoring.label} · {restoring.preview.device || t("backup.unknownDevice")} ·{" "}
                {formatTime(restoring.preview.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <ul className="text-sm space-y-1">
              <li>
                {t("backup.preview.books", {
                  books: restoring.preview.books,
                  here: restoring.preview.booksOnDevice,
                })}
              </li>
              <li>{t("backup.preview.bookmarks", { count: restoring.preview.bookmarks })}</li>
              <li>
                {t("backup.preview.rules", {
                  groups: restoring.preview.groups,
                  replace: restoring.preview.replaceRules,
                  toc: restoring.preview.tocRules,
                })}
              </li>
              {(restoring.preview.onlineBooks > 0 || restoring.preview.bookSources > 0) && (
                <li>
                  {t("backup.preview.online", {
                    books: restoring.preview.onlineBooks,
                    sources: restoring.preview.bookSources,
                  })}
                </li>
              )}
              {restoring.preview.hasPreferences && <li>{t("backup.preview.prefs")}</li>}
              {settings.restoreIgnore.length > 0 && (
                <li className="text-secondary text-xs">
                  {t("backup.preview.ignored")}
                  {restoreCategories()
                    .filter(([category]) => settings.restoreIgnore.includes(category))
                    .map(([, label]) => label)
                    .join(t("common.listSeparator"))}
                </li>
              )}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRestoring(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  run("restore", async () => {
                    const result = await sync.restoreBackup(restoring.source);
                    setRestoring(null);
                    setReport(result);
                    // Restored records replace what the app has loaded.
                    for (const book of runtime.library.getSnapshot().books)
                      runtime.positions.forget(book.book.id);
                    await Promise.all([
                      runtime.library.refresh(),
                      runtime.settings.load(),
                      runtime.shelfPreferences.load(),
                    ]);
                    setPoints(await sync.listRecoveryPoints().catch(() => []));
                  })
                }
              >
                {busy === "restore" ? t("backup.restoring") : t("shelf.bin.restore")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {report && (
        <Dialog open onOpenChange={(open) => !open && setReport(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">
                {t("backup.restored")}
              </DialogTitle>
              <DialogDescription>{t("backup.restored.note")}</DialogDescription>
            </DialogHeader>
            <ul className="text-sm space-y-1">
              <li>
                {t("backup.report.books", {
                  books: report.booksRestored,
                  positions: report.positionsRestored,
                  bookmarks: report.bookmarksAdded,
                })}
              </li>
              {report.booksPending > 0 && (
                <li>{t("backup.report.pending", { count: report.booksPending })}</li>
              )}
              {(report.onlineBooksRestored > 0 || report.sourcesRestored > 0) && (
                <li>
                  {t("backup.report.online", {
                    books: report.onlineBooksRestored,
                    sources: report.sourcesRestored,
                  })}
                </li>
              )}
              <li>
                {t("backup.report.rules", {
                  groups: report.groupsCreated,
                  rules: report.rulesRestored,
                })}
                {report.preferencesRestored ? t("backup.report.prefs") : ""}
              </li>
              {report.webdavRestored && <li>{t("backup.report.webdav")}</li>}
              {report.feedsRestored > 0 && (
                <li>{t("backup.report.feeds", { count: report.feedsRestored })}</li>
              )}
            </ul>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setReport(null)}>
                {t("common.confirm")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </FullPage>
  );
}
