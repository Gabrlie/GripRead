import { useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";
import type { SyncServerStatus } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Icon } from "../ui/Icon";
import { Switch } from "../ui/switch";
import { ServerAccountPage } from "./ServerAccountPage";
import { toast } from "../ui/toast";

function when(at: number | null | undefined): string {
  if (!at) return "尚未同步";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "刚刚同步";
  if (minutes < 60) return `${minutes} 分钟前同步`;
  return `上次同步 ${new Date(at).toLocaleString()}`;
}

/**
 * 服务器同步: connects this device to the GripRead server, which then
 * carries the shelf, progress, bookmarks, rules, sources, and settings
 * between devices instead of WebDAV.
 */
export function ServerSyncPage({ onClose }: { onClose: () => void }) {
  const service = useRuntime().services.sync;
  const [status, setStatus] = useState<SyncServerStatus | null>(null);
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [device, setDevice] = useState("");
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);

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
      <FullPage label="服务器同步" onClose={onClose}>
        {null}
      </FullPage>
    );

  const saved = status.remembered && address.trim() === status.address;
  if (!status.connected)
    return (
      <FullPage label="服务器同步" onClose={onClose}>
        <PageSection title="连接服务器">
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
              }, "已连接，正在同步");
            }}
          >
            <Input
              aria-label="服务器地址"
              placeholder="https://reader.example.com"
              inputMode="url"
              autoCapitalize="none"
              value={address}
              onChange={(change) => setAddress(change.target.value)}
            />
            <Input
              aria-label="密码"
              type="password"
              placeholder={saved ? "使用保存的密码" : "服务器的访问密码"}
              value={password}
              onChange={(change) => setPassword(change.target.value)}
            />
            <Input
              aria-label="设备名"
              placeholder="设备名（在服务器的设备列表中显示）"
              value={device}
              onChange={(change) => setDevice(change.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={busy || !address.trim() || (!password && !saved)}
              >
                {busy ? "连接中…" : "连接"}
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
                    }, "已忘记登录信息")
                  }
                >
                  忘记登录信息
                </Button>
              )}
            </div>
            <p className="text-[11px] text-secondary">
              连接后书架、进度、书签、规则、书源和设置都通过服务器同步，WebDAV
              暂停，断开后恢复。地址、设备名和密码保存在本机，不会进入备份。
            </p>
          </form>
        </PageSection>
      </FullPage>
    );

  return (
    <FullPage label="服务器同步" onClose={onClose}>
      <PageSection title="已连接">
        <div className="p-4 space-y-1 text-sm">
          <p className="truncate">{status.address}</p>
          <p className="text-[11px] text-secondary">
            {status.deviceName ? `${status.deviceName} · ` : ""}
            {status.syncing ? "同步中…" : when(status.lastSync)}
          </p>
          {status.lastError && (
            <p role="alert" className="text-[11px] text-error">
              同步失败：{status.lastError}
            </p>
          )}
        </div>
        <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span>
            自动下载服务器上的书
            <span className="block text-[11px] text-secondary">本机没有的书自动下载导入</span>
          </span>
          <Switch
            aria-label="自动下载服务器上的书"
            checked={status.autoDownload}
            onCheckedChange={(on) => run(() => service.setServerAutoDownload(on))}
          />
        </label>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm"
          onClick={() => setManaging(true)}
        >
          <span>
            服务器管理
            <span className="block text-[11px] text-secondary">
              定时追更、已登录的设备、修改密码
            </span>
          </span>
          <Icon name="chevron_right" size={18} className="text-secondary" />
        </button>
      </PageSection>
      {managing && <ServerAccountPage onClose={() => setManaging(false)} />}
      <PageSection>
        <div className="flex gap-2 p-4">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run(() => service.syncServerNow(), "开始同步")}
          >
            立即同步
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-error"
            disabled={busy}
            onClick={() => run(() => service.disconnectServer(), "已断开，WebDAV 恢复")}
          >
            断开
          </Button>
        </div>
      </PageSection>
      <p className="px-1 text-[11px] text-secondary">
        不想同步的内容在 备份与恢复 › 同步排除 中选择，选中的既不上传，也不会被服务器覆盖。
      </p>
    </FullPage>
  );
}
