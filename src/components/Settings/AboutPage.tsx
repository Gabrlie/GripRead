import { useEffect, useState } from "react";
import { version } from "../../../package.json";
import { useRuntime } from "../../application/runtime";
import { openExternal } from "../../services/external";
import { saveRequest } from "../../application/updates";
import type {
  UpdateChannel,
  UpdateCheck,
  UpdateSettings,
  UpdateSource,
} from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import { Switch } from "../ui/switch";
import { InstallControls } from "../Updates/InstallControls";
import { ReleaseNotes } from "../Updates/ReleaseNotes";
import { useUpdateInstall } from "../Updates/use-update-install";
import { formatDate, useT, type MessageKey } from "../../i18n";
import { t } from "../../i18n";

const REPOSITORY = "https://github.com/Gabrlie/GripRead";

const LINKS: [string, MessageKey | null, string][] = [
  ["code", null, REPOSITORY],
  ["download", "about.releases", `${REPOSITORY}/releases`],
  ["bug_report", "about.issues", `${REPOSITORY}/issues`],
];

/** The version shown in settings and here. */
export const APP_VERSION = version;

const FEATURES: MessageKey[] = [
  "about.feature.import",
  "about.feature.turn",
  "about.feature.sources",
  "about.feature.tools",
  "about.feature.sync",
];

/** 下载方式. */
const SOURCES: UpdateSource[] = ["auto", "direct", "proxy", "accelerator", "server"];

const CHANNELS: UpdateChannel[] = ["stable", "beta"];

function dateLabel(at: number): string {
  return at ? formatDate(at) : "";
}

/**
 * 关于: the app, its version, 检查更新 from GitHub releases (through the
 * connected server when there is one), and 更新日志.
 */
export function AboutPage({ onClose }: { onClose: () => void }) {
  const t = useT();
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

  const [accelerator, setAccelerator] = useState("");
  useEffect(() => setAccelerator(settings?.accelerator ?? ""), [settings?.accelerator]);
  const save = (change: Partial<UpdateSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...change };
    setSettings(next);
    void service.saveSettings(saveRequest(next)).then(
      (saved) => {
        setSettings(saved);
        if (change.channel || change.source || change.accelerator !== undefined) runCheck();
      },
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
  };

  const update = check?.update ?? null;
  return (
    <FullPage label={t("about.title")} onClose={onClose}>
      <div className="flex flex-col items-center text-center gap-2 py-6">
        <img src="/icon-192.png" alt="" className="h-16 w-16 rounded-2xl shadow-sm" />
        <h2 className="font-title-editorial text-xl font-semibold">{t("app.fullName")}</h2>
        <p className="text-xs text-secondary">{t("about.version", { version: APP_VERSION })}</p>
      </div>
      <PageSection title={t("about.intro")}>
        <div className="px-4 py-3 space-y-2 text-sm">
          <p>{t("about.introText")}</p>
          <ul className="space-y-1 text-xs text-secondary">
            {FEATURES.map((feature) => (
              <li key={feature} className="flex gap-2">
                <Icon name="check" size={13} className="text-primary shrink-0 mt-0.5" />
                {t(feature)}
              </li>
            ))}
          </ul>
        </div>
      </PageSection>
      <PageSection title={t("about.project")}>
        {LINKS.map(([icon, label, url]) => (
          <button
            key={url}
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm"
            onClick={() =>
              void openExternal(url).catch((failure: unknown) =>
                toast({
                  text: t("about.linkFailed", { error: describeError(failure) }),
                  error: true,
                }),
              )
            }
          >
            <Icon name={icon} size={18} className="text-secondary shrink-0" />
            <span className="flex-1">
              {label ? t(label) : "GitHub"}
              <span className="block text-[11px] text-secondary break-all">
                {url.replace("https://", "")}
              </span>
            </span>
            <Icon name="open_in_new" size={16} className="text-secondary shrink-0" />
          </button>
        ))}
      </PageSection>
      <PageSection title={t("update.section")}>
        <div className="px-4 py-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">
              {update
                ? t("update.found", { version: update.version })
                : t("update.current", { version: APP_VERSION })}
              <span className="block text-[11px] text-secondary">
                {checking
                  ? t("update.checking")
                  : error
                    ? t("update.checkFailed", { error })
                    : check
                      ? `${
                          update
                            ? t("update.published", { date: dateLabel(update.publishedAt) })
                            : t("update.latest")
                        }${check.viaServer ? t("update.viaServer") : ""}`
                      : ""}
              </span>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={checking || install.state.phase === "downloading"}
              onClick={runCheck}
            >
              {t("update.check")}
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
                {t("update.channel")}
                <span className="block text-[11px] text-secondary">{t("update.channel.note")}</span>
              </span>
              <div
                role="radiogroup"
                aria-label={t("update.channel")}
                className="grid grid-cols-2 gap-1 bg-surface-container p-1 rounded-lg shrink-0"
              >
                {CHANNELS.map((channel) => (
                  <button
                    key={channel}
                    type="button"
                    role="radio"
                    aria-checked={settings.channel === channel}
                    onClick={() => settings.channel !== channel && save({ channel })}
                    className={`h-7 px-3 rounded-md text-xs ${settings.channel === channel ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
                  >
                    {t(`update.channel.${channel}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="px-4 py-3 space-y-2 text-sm">
              <span>
                {t("update.source")}
                <span className="block text-[11px] text-secondary">
                  {t(`update.source.${settings.source}.note`)}
                </span>
              </span>
              <div
                role="radiogroup"
                aria-label={t("update.source")}
                className="grid grid-cols-5 gap-1 bg-surface-container p-1 rounded-lg"
              >
                {SOURCES.map((source) => (
                  <button
                    key={source}
                    type="button"
                    role="radio"
                    aria-checked={settings.source === source}
                    onClick={() => settings.source !== source && save({ source })}
                    className={`h-7 rounded-md text-xs ${settings.source === source ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
                  >
                    {t(`update.source.${source}`)}
                  </button>
                ))}
              </div>
              {settings.source === "accelerator" && (
                <form
                  className="space-y-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save({ accelerator: accelerator.trim() });
                  }}
                >
                  <div className="flex gap-2">
                    <Input
                      aria-label={t("update.accelerator")}
                      inputMode="url"
                      autoCapitalize="none"
                      value={accelerator}
                      placeholder="https://gh-proxy.com/{url}"
                      onChange={(change) => setAccelerator(change.target.value)}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      disabled={accelerator.trim() === settings.accelerator}
                    >
                      {t("common.save")}
                    </Button>
                  </div>
                  <p className="text-[11px] text-secondary">{t("update.accelerator.note")}</p>
                </form>
              )}
            </div>
            <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span>
                {t("update.autoCheck")}
                <span className="block text-[11px] text-secondary">
                  {t("update.autoCheck.note")}
                </span>
              </span>
              <Switch
                aria-label={t("update.autoCheck")}
                checked={settings.autoCheck}
                onCheckedChange={(autoCheck) => save({ autoCheck })}
              />
            </label>
          </>
        )}
      </PageSection>
      <PageSection title={t("update.notes")}>
        {check?.releases.length ? (
          <ol className="divide-y divide-outline-variant/40">
            {check.releases.map((release) => (
              <li key={release.version} className="px-4 py-3 space-y-1.5">
                <p className="text-sm font-semibold">
                  {release.version}
                  {release.prerelease && (
                    <span className="ml-2 text-[11px] font-normal text-secondary">
                      {t("update.beta")}
                    </span>
                  )}
                  {release.version === APP_VERSION && (
                    <span className="ml-2 text-[11px] font-normal text-primary">
                      {t("update.thisVersion")}
                    </span>
                  )}
                  <span className="float-right text-[11px] font-normal text-secondary">
                    {dateLabel(release.publishedAt)}
                  </span>
                </p>
                {release.notes ? (
                  <ReleaseNotes notes={release.notes} />
                ) : (
                  <p className="text-xs text-secondary">{t("update.noNotes")}</p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="px-4 py-3 text-xs text-secondary">
            {checking ? t("update.fetching") : t("update.notesHint")}
          </p>
        )}
      </PageSection>
    </FullPage>
  );
}
