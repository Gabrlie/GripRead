import { sizeLabel } from "../../application/updates";
import type { AvailableUpdate, UpdateKind } from "../../types/generated";
import { Button } from "../ui/button";
import { useT } from "../../i18n";
import type { InstallState } from "./use-update-install";

const IMAGE = "ghcr.io/gabrlie/gripread";

/** What installing `update` looks like on this kind of copy, and its progress. */
export function InstallControls({
  update,
  kind,
  state,
  onInstall,
  onCancel,
}: {
  update: AvailableUpdate;
  kind: UpdateKind;
  state: InstallState;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  if (kind === "server")
    return (
      <div className="space-y-1">
        <p className="text-[11px] text-secondary">{t("update.web")}</p>
        <code className="block select-text break-all rounded-md bg-surface-container px-2 py-1.5 text-[11px]">
          docker pull {IMAGE}:{update.version}
        </code>
      </div>
    );

  if (kind === "android" && !update.asset)
    return <p className="text-[11px] text-secondary">{t("update.noPackage")}</p>;

  if (state.phase === "downloading") {
    const { progress } = state;
    const total = progress?.total ?? update.size ?? null;
    const percent = progress && total ? Math.min(100, (progress.received / total) * 100) : null;
    return (
      <div className="space-y-2">
        <div
          role="progressbar"
          aria-label={t("update.progress")}
          aria-valuenow={percent === null ? undefined : Math.round(percent)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container"
        >
          <div
            className={`h-full bg-primary transition-[width] ${percent === null ? "w-1/3 animate-pulse" : ""}`}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-secondary">
            {kind === "desktop" ? t("update.downloadingInstall") : t("update.downloading")}
            {progress ? ` ${sizeLabel(progress.received)}` : ""}
            {total ? ` / ${sizeLabel(total)}` : ""}
          </span>
          {kind === "android" && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {state.phase === "started" && (
        <p className="text-[11px] text-secondary">
          {kind === "desktop" ? t("update.restarting") : t("update.installerOpened")}
        </p>
      )}
      {state.phase === "permission" && (
        <p className="text-[11px] text-secondary">{t("update.permission")}</p>
      )}
      {state.phase === "failed" && (
        <p role="alert" className="text-[11px] text-error">
          {t("update.failed", { error: state.error })}
        </p>
      )}
      {state.phase !== "started" && (
        <Button size="sm" onClick={onInstall}>
          {state.phase === "failed"
            ? t("common.retry")
            : update.size && kind === "android"
              ? t("update.installSize", { size: sizeLabel(update.size) })
              : t("update.install")}
        </Button>
      )}
    </div>
  );
}
