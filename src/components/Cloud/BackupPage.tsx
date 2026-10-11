import { useCallback, useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";
import type {
  BackupPreview,
  BackupSource,
  RemoteBackup,
  RestoreReport,
  WebDavSettings,
} from "../../types/generated";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { describeError, formatSize, formatTime } from "./format";

/**
 * Legado's 备份与恢复 with WebDAV: the account, backing up to WebDAV or a
 * file, and restoring from either or from a recovery point. A backup holds
 * shelf records, progress, bookmarks, rules, and settings, never books.
 */
export function BackupPage({ onClose }: { onClose: () => void }) {
  const runtime = useRuntime();
  const sync = runtime.services.sync;
  const [settings, setSettings] = useState<WebDavSettings | null>(null);
  const [draft, setDraft] = useState({ url: "", username: "", password: "", autoBackup: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [backups, setBackups] = useState<RemoteBackup[] | null>(null);
  const [points, setPoints] = useState<string[]>([]);
  const [restoring, setRestoring] = useState<{
    source: BackupSource;
    label: string;
    preview: BackupPreview;
  } | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);

  const load = useCallback(async () => {
    const value = await sync.getWebDav();
    setSettings(value);
    setDraft({
      url: value.url,
      username: value.username,
      password: "",
      autoBackup: value.autoBackup,
    });
    setPoints(await sync.listRecoveryPoints().catch(() => []));
  }, [sync]);
  useEffect(() => {
    void load().catch((error: unknown) => setMessage({ text: describeError(error), error: true }));
  }, [load]);

  const run = async (label: string, work: () => Promise<string | void>) => {
    setBusy(label);
    setMessage(null);
    try {
      const text = await work();
      if (text) setMessage({ text });
    } catch (error) {
      setMessage({ text: describeError(error), error: true });
    } finally {
      setBusy(null);
    }
  };
  const request = () => ({
    url: draft.url.trim(),
    username: draft.username.trim(),
    password: draft.password ? draft.password : null,
    autoBackup: draft.autoBackup,
  });
  const configured = Boolean(settings?.url);
  const changed =
    settings !== null &&
    (draft.url.trim() !== settings.url ||
      draft.username.trim() !== settings.username ||
      draft.password !== "" ||
      draft.autoBackup !== settings.autoBackup);
  const preview = (source: BackupSource, label: string) =>
    run("preview", async () => {
      setRestoring({ source, label, preview: await sync.previewBackup(source) });
    });

  return (
    <FullPage label="备份与恢复" onClose={onClose}>
      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`rounded-lg px-3 py-2 text-xs break-words ${message.error ? "bg-error-container text-error" : "bg-surface-container text-primary"}`}
        >
          {message.text}
        </p>
      )}
      <PageSection title="WebDAV 账号">
        <div className="p-4 space-y-3">
          <label className="block space-y-1 text-xs text-secondary">
            服务器地址
            <Input
              value={draft.url}
              inputMode="url"
              placeholder="https://dav.jianguoyun.com/dav/"
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-xs text-secondary">
            账号
            <Input
              value={draft.username}
              autoComplete="username"
              onChange={(event) => setDraft({ ...draft, username: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-xs text-secondary">
            密码
            <Input
              type="password"
              value={draft.password}
              autoComplete="current-password"
              placeholder={
                settings?.hasPassword ? "已保存，留空则不修改" : "坚果云请填写第三方应用密码"
              }
              onChange={(event) => setDraft({ ...draft, password: event.target.value })}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              每日自动备份
              <span className="block text-[11px] text-secondary">
                启动时检查，记录有变化才备份，保留最近 7 份
              </span>
            </span>
            <Switch
              aria-label="每日自动备份"
              checked={draft.autoBackup}
              onCheckedChange={(autoBackup) => setDraft({ ...draft, autoBackup })}
            />
          </label>
          <p className="text-[11px] text-secondary">密码只保存在本机，不会写入备份。</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!draft.url.trim() || busy !== null}
              onClick={() =>
                run("test", async () => {
                  await sync.testWebDav(request());
                  return "连接成功。";
                })
              }
            >
              测试连接
            </Button>
            <Button
              size="sm"
              disabled={!changed || busy !== null}
              onClick={() =>
                run("save", async () => {
                  const saved = await sync.saveWebDav(request());
                  setSettings(saved);
                  setDraft({ ...draft, password: "" });
                  return "已保存。";
                })
              }
            >
              保存
            </Button>
          </div>
        </div>
      </PageSection>

      <PageSection title="备份">
        <div className="p-4 space-y-3">
          <p className="text-xs text-secondary">
            备份书架记录、阅读进度、书签、阅读时长、分组、规则和阅读设置，不包含书籍文件；书籍请用云书架上传。
          </p>
          {settings?.lastBackupAt && (
            <p className="text-xs">上次备份：{formatTime(settings.lastBackupAt)}</p>
          )}
          {settings?.lastError && (
            <p className="text-xs text-error break-words">自动备份失败：{settings.lastError}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!configured || changed || busy !== null}
              onClick={() =>
                run("backup", async () => {
                  const backup = await sync.backupNow();
                  await load();
                  if (backups) setBackups(await sync.listBackups());
                  return `已备份到 WebDAV：${backup.name}`;
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
                  (await sync.exportBackupFile()) ? "备份文件已保存。" : undefined,
                )
              }
            >
              <Icon name="save" size={14} />
              导出到文件
            </Button>
          </div>
          {!configured && (
            <p className="text-[11px] text-secondary">设置并保存 WebDAV 账号后可备份到云端。</p>
          )}
        </div>
      </PageSection>

      <PageSection title="恢复">
        <div className="p-4 space-y-3">
          <p className="text-xs text-secondary">
            恢复会合并到当前书架：本机已有的书按备份恢复信息和分组，进度取较新的一份，书签合并；本机没有的书在导入或从云书架下载后自动恢复。恢复前会先保存一个本机恢复点。
          </p>
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
                    <span className="block text-[11px] text-secondary truncate">{backup.name}</span>
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
                        return "已删除。";
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
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PageSection>

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
              {restoring.preview.hasPreferences && <li>阅读设置（字体和背景图保留本机的）</li>}
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
              <li>
                新建分组 {report.groupsCreated} 个，规则 {report.rulesRestored} 条
                {report.preferencesRestored ? "，阅读设置已恢复" : ""}
              </li>
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
