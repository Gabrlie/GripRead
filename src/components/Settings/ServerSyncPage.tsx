import { useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";
import type { RestoreCategory, SyncServerStatus, WebDavSettings } from "../../types/generated";
import { restoreCategories, switchRequest } from "../Cloud/BackupPage";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { ServerAccountSections } from "./ServerAccountPage";
import { toast } from "../ui/toast";
import { formatDateTime, t } from "../../i18n";

function when(at: number | null | undefined): string {
  if (!at) return t("server.notSynced");
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return t("server.justSynced");
  if (minutes < 60) return t("server.syncedMinutes", { minutes });
  return t("server.syncedAt", { time: formatDateTime(at) });
}

/**
 * 同步内容: what syncs with the server, one row opening a dialog with a
 * switch per category. It is the 同步排除 list of 备份与恢复 seen the other
 * way round (on = synced), so either page changes both.
 */
function SyncContentSection() {
  const sync = useRuntime().services.sync;
  const [settings, setSettings] = useState<WebDavSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let active = true;
    void sync.getWebDav().then(
      (value) => active && setSettings(value),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [sync]);
  if (!settings) return null;
  const categories = restoreCategories();
  const synced = categories.filter(([category]) => !settings.restoreIgnore.includes(category));
  const toggle = (category: RestoreCategory, on: boolean) => {
    const restoreIgnore = on
      ? settings.restoreIgnore.filter((item) => item !== category)
      : [...settings.restoreIgnore, category];
    setBusy(true);
    void sync
      .saveWebDav(switchRequest(settings, { restoreIgnore }))
      .then(setSettings, (error: unknown) => toast({ text: describeError(error), error: true }))
      .finally(() => setBusy(false));
  };
  return (
    <PageSection title={t("server.content")}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-sm text-left"
      >
        <span className="min-w-0">
          {t("server.content")}
          <span className="block text-[11px] text-secondary truncate">
            {synced.length === categories.length
              ? t("server.content.all")
              : synced.map(([, label]) => label).join("、") || t("server.content.none")}
          </span>
        </span>
        <span className="shrink-0 text-xs text-secondary tabular-nums">
          {t("server.content.count", { count: synced.length, total: categories.length })}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm max-h-[86dvh] overflow-y-auto p-5 gap-1">
          <DialogHeader>
            <DialogTitle className="font-title-editorial text-base">
              {t("server.content")}
            </DialogTitle>
            <DialogDescription>{t("server.content.note")}</DialogDescription>
          </DialogHeader>
          {categories.map(([category, label, note]) => (
            <label key={category} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                {label}
                {note && <span className="block text-[11px] text-secondary">{note}</span>}
              </span>
              <Switch
                aria-label={t("server.syncOne", { label })}
                checked={!settings.restoreIgnore.includes(category)}
                disabled={busy}
                onCheckedChange={(on) => toggle(category, on)}
              />
            </label>
          ))}
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}

/**
 * 服务器: connects this device to the GripRead server, which then carries
 * the shelf, progress, bookmarks, rules, sources, and settings between
 * devices instead of WebDAV. While connected it also holds what syncs, how
 * books update, and the server's own settings (服务器管理).
 */
export function ServerSyncPage({ onClose }: { onClose: () => void }) {
  const service = useRuntime().services.sync;
  const [status, setStatus] = useState<SyncServerStatus | null>(null);
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [device, setDevice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    void service.getServer().then((value) => {
      if (!active) return;
      setStatus(value);
      // The last sign-in is kept on this device.
      if (value.remembered) {
        setAddress(value.address);
        if (value.deviceName) setDevice(value.deviceName);
      }
    });
    void service.getWebDav().then(
      (webdav) => active && setDevice((current) => current || webdav.deviceName),
      () => undefined,
    );
    void service
      .onServerStatus((value) => active && setStatus(value))
      .then((unsubscribe) => {
        if (active) stop = unsubscribe;
        else unsubscribe();
      });
    return () => {
      active = false;
      stop?.();
    };
  }, [service]);

  const run = (work: () => Promise<SyncServerStatus | void>, done?: string) => {
    setBusy(true);
    void work()
      .then(
        (value) => {
          if (value) setStatus(value);
          if (done) toast(done);
        },
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => setBusy(false));
  };

  if (!status)
    return (
      <FullPage label={t("settings.server")} onClose={onClose}>
        {null}
      </FullPage>
    );

  const saved = status.remembered && address.trim() === status.address;
  if (!status.connected)
    return (
      <FullPage label={t("settings.server")} onClose={onClose}>
        <PageSection title={t("server.connectTitle")}>
          <form
            className="p-4 space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              run(async () => {
                const connected = await service.connectServer({
                  address,
                  password,
                  deviceName: device.trim(),
                });
                setPassword("");
                return connected;
              }, t("server.connected"));
            }}
          >
            <Input
              aria-label={t("backup.url")}
              placeholder="https://reader.example.com"
              inputMode="url"
              autoCapitalize="none"
              value={address}
              onChange={(change) => setAddress(change.target.value)}
            />
            <Input
              aria-label={t("network.proxy.password")}
              type="password"
              placeholder={saved ? t("server.savedPassword") : t("server.password")}
              value={password}
              onChange={(change) => setPassword(change.target.value)}
            />
            <Input
              aria-label={t("server.device")}
              placeholder={t("server.device.placeholder")}
              value={device}
              onChange={(change) => setDevice(change.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={busy || !address.trim() || (!password && !saved)}
              >
                {busy ? t("server.connecting") : t("server.connect")}
              </Button>
              {status.remembered && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const value = await service.forgetServerLogin();
                      setAddress("");
                      setPassword("");
                      return value;
                    }, t("server.forgotten"))
                  }
                >
                  {t("server.forget")}
                </Button>
              )}
            </div>
            <p className="text-[11px] text-secondary">{t("server.connectNote")}</p>
          </form>
        </PageSection>
      </FullPage>
    );

  return (
    <FullPage label={t("settings.server")} onClose={onClose}>
      <PageSection title={t("server.connectedTitle")}>
        <div className="p-4 space-y-1 text-sm">
          <p className="truncate">{status.address}</p>
          <p className="text-[11px] text-secondary">
            {status.deviceName ? `${status.deviceName} · ` : ""}
            {status.syncing ? t("server.syncing") : when(status.lastSync)}
          </p>
          {status.lastError && (
            <p role="alert" className="text-[11px] text-error">
              {t("settings.server.failed", { error: status.lastError })}
            </p>
          )}
        </div>
        <div className="flex gap-2 px-4 pb-4">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => service.syncServerNow(), t("server.syncStarted"))}
          >
            {t("server.syncNow")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-error"
            disabled={busy}
            onClick={() => run(() => service.disconnectServer(), t("server.disconnected"))}
          >
            {t("server.disconnect")}
          </Button>
        </div>
      </PageSection>
      <PageSection title={t("records.books")}>
        <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span>
            {t("server.autoDownload")}
            <span className="block text-[11px] text-secondary">
              {t("server.autoDownload.note")}
            </span>
          </span>
          <Switch
            aria-label={t("server.autoDownload")}
            checked={status.autoDownload}
            onCheckedChange={(on) => run(() => service.setServerAutoDownload(on))}
          />
        </label>
        <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span>
            {t("server.updateVia")}
            <span className="block text-[11px] text-secondary">{t("server.updateVia.note")}</span>
          </span>
          <Switch
            aria-label={t("server.updateVia")}
            checked={status.updateViaServer}
            onCheckedChange={(on) => run(() => service.setServerUpdateViaServer(on))}
          />
        </label>
      </PageSection>
      <SyncContentSection />
      <ServerAccountSections />
    </FullPage>
  );
}
