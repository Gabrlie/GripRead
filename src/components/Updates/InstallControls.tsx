import { sizeLabel } from "../../application/updates";
import type { AvailableUpdate, UpdateKind } from "../../types/generated";
import { Button } from "../ui/button";
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
  if (kind === "server")
    return (
      <div className="space-y-1">
        <p className="text-[11px] text-secondary">
          网页版随服务器更新，在服务器上拉取新镜像后重启容器：
        </p>
        <code className="block select-text break-all rounded-md bg-surface-container px-2 py-1.5 text-[11px]">
          docker pull {IMAGE}:{update.version}
        </code>
      </div>
    );

  if (kind === "android" && !update.asset)
    return (
      <p className="text-[11px] text-secondary">这个版本没有适合本机的安装包，请到发布页下载。</p>
    );

  if (state.phase === "downloading") {
    const { progress } = state;
    const total = progress?.total ?? update.size ?? null;
    const percent = progress && total ? Math.min(100, (progress.received / total) * 100) : null;
    return (
      <div className="space-y-2">
        <div
          role="progressbar"
          aria-label="下载进度"
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
            {kind === "desktop" ? "正在下载并安装" : "正在下载"}
            {progress ? ` ${sizeLabel(progress.received)}` : ""}
            {total ? ` / ${sizeLabel(total)}` : ""}
          </span>
          {kind === "android" && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              取消
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
          {kind === "desktop" ? "更新完成，正在重启…" : "已打开系统安装程序，按提示完成安装。"}
        </p>
      )}
      {state.phase === "permission" && (
        <p className="text-[11px] text-secondary">
          请在打开的设置中允许手不释卷「安装未知应用」，返回后再点一次立即更新。
        </p>
      )}
      {state.phase === "failed" && (
        <p role="alert" className="text-[11px] text-error">
          更新失败：{state.error}
        </p>
      )}
      {state.phase !== "started" && (
        <Button size="sm" onClick={onInstall}>
          {state.phase === "failed" ? "重试" : "立即更新"}
          {update.size && kind === "android" ? `（${sizeLabel(update.size)}）` : ""}
        </Button>
      )}
    </div>
  );
}
