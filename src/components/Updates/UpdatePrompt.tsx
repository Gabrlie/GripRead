import { useEffect, useState } from "react";
import { autoCheckDue, promptFor, saveRequest } from "../../application/updates";
import { useRuntime } from "../../application/runtime";
import { native } from "../../services/transport";
import type { AvailableUpdate, UpdateKind, UpdateSettings } from "../../types/generated";
import { APP_VERSION } from "../Settings/AboutPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { InstallControls } from "./InstallControls";
import { ReleaseNotes } from "./ReleaseNotes";
import { useUpdateInstall } from "./use-update-install";

/**
 * 自动检查更新: once a day, at start or on returning to the app, it checks
 * its channel and offers a newer version: 立即更新, 跳过此版本, or 稍后
 * (asked again tomorrow). Checks on 关于 do not count toward the day.
 */
export function UpdatePrompt() {
  const service = useRuntime().services.updates;
  const [offer, setOffer] = useState<{
    update: AvailableUpdate;
    kind: UpdateKind;
    settings: UpdateSettings;
  } | null>(null);
  const install = useUpdateInstall(service);

  useEffect(() => {
    if (!native) return;
    let active = true;
    let running = false;
    const run = () => {
      if (running) return;
      running = true;
      void (async () => {
        const settings = await service.getSettings();
        if (!autoCheckDue(settings)) return;
        const check = await service.check(APP_VERSION, true);
        const update = promptFor(check, settings);
        if (active && update) setOffer({ update, kind: check.kind, settings });
      })()
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    };
    run();
    const returned = () => document.visibilityState === "visible" && run();
    document.addEventListener("visibilitychange", returned);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", returned);
    };
  }, [service]);

  if (!offer) return null;
  const { update, kind, settings } = offer;
  const close = () => {
    install.cancel();
    setOffer(null);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            发现新版本 {update.version}
          </DialogTitle>
          <DialogDescription>当前版本 {APP_VERSION}</DialogDescription>
        </DialogHeader>
        {update.notes && (
          <div className="max-h-60 overflow-y-auto rounded-lg bg-surface-container-low p-3">
            <ReleaseNotes notes={update.notes} />
          </div>
        )}
        <InstallControls
          update={update}
          kind={kind}
          state={install.state}
          onInstall={() => install.start(update.version)}
          onCancel={install.cancel}
        />
        {install.state.phase !== "downloading" && (
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void service.saveSettings(saveRequest(settings, { skipped: update.version }));
                close();
              }}
            >
              跳过此版本
            </Button>
            <Button variant="ghost" size="sm" onClick={close}>
              稍后
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
