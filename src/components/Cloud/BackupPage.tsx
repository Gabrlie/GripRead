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
import { toast } from "../ui/toast";
import { Switch } from "../ui/switch";
import { describeError, formatSize, formatTime } from "./format";

/** Legado's 恢复忽略列表 entries for GripRead's backup contents. */
export const RESTORE_CATEGORIES: [RestoreCategory, string, string][] = [
  ["reading-settings", "阅读设置", "字体、排版、翻页、朗读等阅读界面设置"],
  ["theme", "主题与纸张色调", "深浅色、纸张色调和 OLED 纯黑"],
  ["shelf-layout", "书架布局", "布局、排序和当前分组"],
  ["replace-rules", "替换规则", ""],
  ["toc-rules", "目录规则", ""],
  ["groups", "分组", "新建备份里的分组"],
  ["book-info", "书籍信息", "书名、作者、简介、封面、所在分组"],
  ["progress", "阅读进度", ""],
  ["bookmarks", "书签", ""],
  ["reading-time", "阅读时长", ""],
  ["sources", "书源", "书源的规则、开关、分组和顺序"],
  ["online-books", "网络书籍", "书架上的网络书籍和它们的进度、书签"],
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
    void load().catch((error: unknown) => toast({ text: describeError(error), error: true }));
  }, [load]);

  const run = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label);
    try {
      const text = await work();
      if (text) toast(text);
    } catch (error) {
      toast({ text: describeError(error), error: true });
    } finally {
      setBusy(null);
    }
  };
  if (!settings || !draft)
    return (
      <FullPage label="备份与恢复" onClose={onClose}>
        <p role="status" className="text-sm text-secondary px-1">
          正在读取…
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
    <p className="text-[11px] text-error">
      延迟较高（{latency.latencyMs} ms），不建议开启同步阅读进度和同步增强。
    </p>
  );

  return (
    <FullPage label="备份与恢复" onClose={onClose}>
      <ServerPausedNote />
      <PageSection title="WebDAV 账号">
        <div className="p-4 space-y-3">
          {field("服务器地址", "url", "留空使用坚果云", { inputMode: "url" })}
          {field("账号", "username", "", { autoComplete: "username" })}
          <label className="block space-y-1 text-xs text-secondary">
            密码
            <span className="relative block">
              <Input
                type={showPassword ? "text" : "password"}
                value={draft.password}
                autoComplete="current-password"
                placeholder="坚果云请填写第三方应用密码"
                className="pr-10"
                onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              />
              <button
                type="button"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 flex items-center justify-center text-secondary"
                onClick={() => setShowPassword((shown) => !shown)}
              >
                <Icon name={showPassword ? "visibility_off" : "visibility"} size={16} />
              </button>
            </span>
          </label>
          {field("子文件夹", "folder", "GripRead")}
          {field("设备名称", "deviceName", deviceFallback)}
          <p className="text-[11px] text-secondary">
            备份文件名带上设备名称，便于区分来源。账号和密码只写入保存在本机的备份文件（导出到文件、本机备份文件夹），不会上传到
            WebDAV。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!(draft.url.trim() || draft.username.trim()) || busy !== null}
              onClick={() =>
                run("test", async () => {
                  const result = await sync.testWebDav(request());
                  setLatency(result);
                  return `连接成功，延迟 ${result.latencyMs} ms`;
                })
              }
            >
              {busy === "test" ? "正在测试…" : "测试连接"}
            </Button>
            <Button
              size="sm"
              disabled={!accountChanged || busy !== null}
              onClick={() =>
                run("save", async () => {
                  apply(await sync.saveWebDav(request()));
                  return "已保存";
                })
              }
            >
              保存
            </Button>
          </div>
          {slowWarning}
        </div>
      </PageSection>

      <PageSection title="同步">
        <div className="p-4 space-y-4">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              同步阅读进度
              <span className="block text-[11px] text-secondary">
                进入、退出阅读界面时同步；其他设备有新进度时询问是否跳转
              </span>
            </span>
            <Switch
              aria-label="同步阅读进度"
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
              同步增强
              <span className="block text-[11px] text-secondary">回到应用或网络恢复时也同步</span>
            </span>
            <Switch
              aria-label="同步增强"
              checked={draft.syncProgressPlus}
              disabled={busy !== null || !draft.syncProgress}
              onCheckedChange={(syncProgressPlus) => saveSwitch({ syncProgressPlus })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>自动同步书籍信息到云书架</span>
            <Switch
              aria-label="自动同步书籍信息到云书架"
              checked={draft.autoSyncBookInfo ?? false}
              disabled={busy !== null}
              onCheckedChange={(autoSyncBookInfo) => saveSwitch({ autoSyncBookInfo })}
            />
          </label>
          {slowWarning}
          {!configured && <p className="text-[11px] text-secondary">设置 WebDAV 账号后生效。</p>}
        </div>
      </PageSection>

      <PageSection title="备份">
        <div className="p-4 space-y-3">
          <p className="text-xs text-secondary">不包含书籍文件，书籍请用云书架上传。</p>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0">
              本地备份文件夹
              <span className="block text-[11px] text-secondary truncate">
                {settings.localFolder ?? "未选择；选择后自动备份也会保存到这里"}
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
                选择
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
                  清除
                </Button>
              )}
            </span>
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              每日自动备份
              <span className="block text-[11px] text-secondary">有变化时备份，保留最近 7 份</span>
            </span>
            <Switch
              aria-label="每日自动备份"
              checked={draft.autoBackup}
              disabled={busy !== null}
              onCheckedChange={(autoBackup) => saveSwitch({ autoBackup })}
            />
          </label>
          {settings.lastBackupAt && (
            <p className="text-xs">上次备份：{formatTime(settings.lastBackupAt)}</p>
          )}
          {settings.lastError && (
            <p className="text-xs text-error break-words">
              上次同步失败：{describeError(settings.lastError)}
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
                  return `已备份：${backup.name}`;
                })
              }
            >
              <Icon name="cloud" size={14} />
              {busy === "backup" ? "正在备份…" : "备份到 WebDAV"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                run("export", async () =>
                  (await sync.exportBackupFile()) ? "备份文件已保存" : undefined,
                )
              }
            >
              <Icon name="save" size={14} />
              导出到文件
            </Button>
          </div>
        </div>
      </PageSection>

      <PageSection title="恢复">
        <div className="p-4 space-y-3">
          <p className="text-xs text-secondary">恢复前会先保存一个本机恢复点。</p>
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
              {busy === "list" ? "正在读取…" : "从 WebDAV 恢复"}
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
                      label: "所选文件",
                      preview: await sync.previewBackup(source),
                    });
                })
              }
            >
              <Icon name="folder_open" size={14} />
              从文件恢复
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIgnoring(true)}>
              同步排除
              {settings.restoreIgnore.length > 0 && (
                <span className="ml-1 text-[11px] text-secondary">
                  {settings.restoreIgnore.length} 项
                </span>
              )}
            </Button>
          </div>
          {backups && (
            <ul aria-label="WebDAV 备份" className="space-y-1">
              {backups.length === 0 && (
                <li className="text-xs text-secondary py-2">WebDAV 上还没有备份。</li>
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
                        {backup.automatic ? "自动" : "手动"} · {formatSize(backup.size)}
                      </span>
                    </span>
                    <span className="block text-[11px] text-secondary truncate">
                      {backup.device ? `来自 ${backup.device}` : backup.name}
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
                    恢复
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`删除备份 ${backup.name}`}
                    className="h-8 w-8 text-secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      run("delete", async () => {
                        await sync.deleteBackup(backup.name);
                        setBackups(await sync.listBackups());
                        return "已删除";
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
              <p className="text-[11px] text-secondary">本机恢复点（恢复前自动保存）</p>
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
                      恢复
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`删除恢复点 ${formatTime(time)}`}
                      className="h-8 w-8 text-secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        run("delete", async () => {
                          await sync.deleteRecoveryPoint(point);
                          setPoints(await sync.listRecoveryPoints());
                          return "已删除";
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
              <DialogTitle className="font-title-editorial text-base">同步排除</DialogTitle>
              <DialogDescription>
                开启的内容保留本机的：恢复备份时不覆盖，连接服务器时既不上传也不被覆盖。
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-1">
              {RESTORE_CATEGORIES.map(([category, label, note]) => (
                <li key={category}>
                  <label className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface-container">
                    <span>
                      {label}
                      {note && <span className="block text-[11px] text-secondary">{note}</span>}
                    </span>
                    <Switch
                      aria-label={`恢复时忽略${label}`}
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
              <DialogTitle className="font-title-editorial text-base">恢复备份</DialogTitle>
              <DialogDescription>
                {restoring.label} · {restoring.preview.device || "未知设备"} ·{" "}
                {formatTime(restoring.preview.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <ul className="text-sm space-y-1">
              <li>
                书籍 {restoring.preview.books} 本，本机已有 {restoring.preview.booksOnDevice} 本
              </li>
              <li>书签 {restoring.preview.bookmarks} 个</li>
              <li>
                分组 {restoring.preview.groups} 个，替换规则 {restoring.preview.replaceRules}{" "}
                条，自定义目录规则 {restoring.preview.tocRules} 条
              </li>
              {(restoring.preview.onlineBooks > 0 || restoring.preview.bookSources > 0) && (
                <li>
                  网络书籍 {restoring.preview.onlineBooks} 本，书源 {restoring.preview.bookSources}{" "}
                  个
                </li>
              )}
              {restoring.preview.hasPreferences && <li>阅读设置（字体和背景图保留本机的）</li>}
              {settings.restoreIgnore.length > 0 && (
                <li className="text-secondary text-xs">
                  忽略：
                  {RESTORE_CATEGORIES.filter(([category]) =>
                    settings.restoreIgnore.includes(category),
                  )
                    .map(([, label]) => label)
                    .join("、")}
                </li>
              )}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setRestoring(null)}>
                取消
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
                {busy === "restore" ? "正在恢复…" : "恢复"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {report && (
        <Dialog open onOpenChange={(open) => !open && setReport(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">已恢复</DialogTitle>
              <DialogDescription>恢复前的状态已保存为本机恢复点。</DialogDescription>
            </DialogHeader>
            <ul className="text-sm space-y-1">
              <li>
                书籍 {report.booksRestored} 本，进度 {report.positionsRestored} 本，新增书签{" "}
                {report.bookmarksAdded} 个
              </li>
              {report.booksPending > 0 && (
                <li>{report.booksPending} 本书不在本机，导入或从云书架下载后会自动恢复记录</li>
              )}
              {(report.onlineBooksRestored > 0 || report.sourcesRestored > 0) && (
                <li>
                  网络书籍 {report.onlineBooksRestored} 本，书源 {report.sourcesRestored} 个
                  （目录在第一次打开时读取）
                </li>
              )}
              <li>
                新建分组 {report.groupsCreated} 个，规则 {report.rulesRestored} 条
                {report.preferencesRestored ? "，阅读设置已恢复" : ""}
              </li>
              {report.webdavRestored && <li>WebDAV 账号已恢复</li>}
            </ul>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setReport(null)}>
                好的
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </FullPage>
  );
}
