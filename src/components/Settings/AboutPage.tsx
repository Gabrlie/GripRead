import { useEffect, useState } from "react";
import { version } from "../../../package.json";
import { useRuntime } from "../../application/runtime";
import type { UpdateChannel, UpdateCheck, UpdateSettings } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Switch } from "../ui/switch";
import { InstallControls } from "../Updates/InstallControls";
import { ReleaseNotes } from "../Updates/ReleaseNotes";
import { useUpdateInstall } from "../Updates/use-update-install";

/** The version shown in settings and here. */
export const APP_VERSION = version;

const FEATURES = [
  "本地 TXT 导入，自动识别编码和章节",
  "仿真、覆盖、平移等翻页，单页、双页和滚动阅读",
  "兼容阅读（Legado）书源，追更与离线缓存",
  "替换净化、简繁转换、朗读与自动翻页",
  "WebDAV 备份，自建服务器多端实时同步",
];

const CHANNELS: [UpdateChannel, string][] = [
  ["stable", "正式版"],
  ["beta", "测试版"],
];

function dateLabel(at: number): string {
  return at ? new Date(at).toLocaleDateString() : "";
}

/**
 * 关于: the app, its version, 检查更新 from GitHub releases (through the
 * connected server when there is one), and 更新日志.
 */
export function AboutPage({ onClose }: { onClose: () => void }) {
  const service = useRuntime().services.updates;
  const [settings, setSettings] = useState<UpdateSettings | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = useUpdateInstall(service);

  const runCheck = () => {
    setChecking(true);
    setError(null);
    void service
      .check(APP_VERSION)
      .then(setCheck, (failure: unknown) => setError(describeError(failure)))
      .finally(() => setChecking(false));
  };

  useEffect(() => {
    void service.getSettings().then(setSettings, () => undefined);
    // Checks once when the page opens.
    runCheck();
  }, [service]);

  const save = (change: Partial<UpdateSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...change };
    setSettings(next);
    void service
      .saveSettings({ channel: next.channel, autoCheck: next.autoCheck, skipped: next.skipped })
      .then((saved) => {
        setSettings(saved);
        if (change.channel) runCheck();
      });
  };

  const update = check?.update ?? null;
  return (
    <FullPage label="关于" onClose={onClose}>
      <div className="flex flex-col items-center text-center gap-2 py-6">
        <img src="/icon-192.png" alt="" className="h-16 w-16 rounded-2xl shadow-sm" />
        <h2 className="font-title-editorial text-xl font-semibold">手不释卷 · GripRead</h2>
        <p className="text-xs text-secondary">版本 {APP_VERSION}</p>
      </div>
      <PageSection title="简介">
        <div className="px-4 py-3 space-y-2 text-sm">
          <p>
            一款本地优先的小说阅读器，功能和布局参考「阅读（Legado）」，不需要账号也能完整使用。
          </p>
          <ul className="space-y-1 text-xs text-secondary">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex gap-2">
                <Icon name="check" size={13} className="text-primary shrink-0 mt-0.5" />
                {feature}
              </li>
            ))}
          </ul>
        </div>
      </PageSection>
      <PageSection title="更新">
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">
              {update ? `发现新版本 ${update.version}` : `当前版本 ${APP_VERSION}`}
              <span className="block text-[11px] text-secondary">
                {checking
                  ? "正在检查…"
                  : error
                    ? `检查失败：${error}`
                    : check
                      ? update
                        ? `${dateLabel(update.publishedAt)} 发布${check.viaServer ? " · 经由服务器" : ""}`
                        : `已是最新版本${check.viaServer ? " · 经由服务器" : ""}`
                      : ""}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={checking || install.state.phase === "downloading"}
              onClick={runCheck}
            >
              检查更新
            </Button>
          </div>
          {update && check && (
            <>
              {update.notes && (
                <div className="max-h-64 overflow-y-auto rounded-lg bg-surface-container-low p-3">
                  <ReleaseNotes notes={update.notes} />
                </div>
              )}
              <InstallControls
                update={update}
                kind={check.kind}
                state={install.state}
                onInstall={() => install.start(update.version)}
                onCancel={install.cancel}
              />
            </>
          )}
        </div>
        {settings && (
          <>
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span>
                更新渠道
                <span className="block text-[11px] text-secondary">测试版更新更快，可能不稳定</span>
              </span>
              <div
                role="radiogroup"
                aria-label="更新渠道"
                className="grid grid-cols-2 gap-1 bg-surface-container p-1 rounded-lg shrink-0"
              >
                {CHANNELS.map(([channel, label]) => (
                  <button
                    key={channel}
                    type="button"
                    role="radio"
                    aria-checked={settings.channel === channel}
                    onClick={() => settings.channel !== channel && save({ channel })}
                    className={`h-7 px-3 rounded-md text-xs ${settings.channel === channel ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span>
                自动检查更新
                <span className="block text-[11px] text-secondary">每天打开应用时检查一次</span>
              </span>
              <Switch
                aria-label="自动检查更新"
                checked={settings.autoCheck}
                onCheckedChange={(autoCheck) => save({ autoCheck })}
              />
            </label>
          </>
        )}
      </PageSection>
      <PageSection title="更新日志">
        {check?.releases.length ? (
          <ol className="divide-y divide-outline-variant/40">
            {check.releases.map((release) => (
              <li key={release.version} className="px-4 py-3 space-y-1.5">
                <p className="text-sm font-semibold">
                  {release.version}
                  {release.prerelease && (
                    <span className="ml-2 text-[11px] font-normal text-secondary">测试版</span>
                  )}
                  {release.version === APP_VERSION && (
                    <span className="ml-2 text-[11px] font-normal text-primary">当前版本</span>
                  )}
                  <span className="float-right text-[11px] font-normal text-secondary">
                    {dateLabel(release.publishedAt)}
                  </span>
                </p>
                {release.notes ? (
                  <ReleaseNotes notes={release.notes} />
                ) : (
                  <p className="text-xs text-secondary">没有说明</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="px-4 py-3 text-xs text-secondary">
            {checking ? "正在获取…" : "检查更新后显示各版本的更新内容。"}
          </p>
        )}
      </PageSection>
    </FullPage>
  );
}
