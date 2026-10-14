import { useEffect, useState } from "react";
import { JobsSection } from "./ServerJobsSection";
import { serverAccount, type ServerSession } from "../../services/server";
import { native } from "../../services/transport";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";

function seen(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 10) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`;
  return new Date(at).toLocaleDateString();
}

/**
 * 服务器账号 in the web version, and 服务器管理 in the app while connected:
 * 定时追更, the devices signed in (设备管理), 修改密码, and (on the web)
 * 退出登录.
 */
export function ServerAccountPage({ onClose }: { onClose: () => void }) {
  const [sessions, setSessions] = useState<ServerSession[] | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    void serverAccount
      .sessions()
      .then(setSessions, (error: unknown) => toast({ text: describeError(error), error: true }));
  useEffect(load, []);

  const revoke = (session: ServerSession) =>
    void serverAccount.revoke(session.id).then(
      () => {
        toast(`已退出：${session.device}`);
        load();
      },
      (error: unknown) => toast({ text: describeError(error), error: true }),
    );

  const changePassword = () => {
    setBusy(true);
    void serverAccount
      .changePassword(current, next)
      .then(
        () => {
          setCurrent("");
          setNext("");
          toast("密码已修改，其他设备需要重新登录");
          load();
        },
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => setBusy(false));
  };

  const logout = () =>
    void serverAccount.logout().then(
      () => location.reload(),
      (error: unknown) => toast({ text: describeError(error), error: true }),
    );

  return (
    <FullPage label={native ? "服务器管理" : "服务器账号"} onClose={onClose}>
      <JobsSection />
      <PageSection title="已登录的设备">
        {sessions === null && <p className="p-4 text-sm text-secondary">正在读取…</p>}
        {sessions?.map((session) => (
          <div key={session.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <span className="flex-1 min-w-0">
              <span className="block truncate">
                {session.device}
                {session.current && <span className="ml-1.5 text-[11px] text-primary">本机</span>}
              </span>
              <span className="block text-[11px] text-secondary">{seen(session.lastSeen)}</span>
            </span>
            {!session.current && (
              <Button size="sm" variant="ghost" onClick={() => revoke(session)}>
                退出
              </Button>
            )}
          </div>
        ))}
      </PageSection>

      <PageSection title="修改密码">
        <div className="p-4 space-y-2">
          <Input
            type="password"
            aria-label="当前密码"
            placeholder="当前密码"
            autoComplete="current-password"
            value={current}
            onChange={(change) => setCurrent(change.target.value)}
          />
          <Input
            type="password"
            aria-label="新密码"
            placeholder="新密码（至少 6 位）"
            autoComplete="new-password"
            value={next}
            onChange={(change) => setNext(change.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !current || next.length < 6}
            onClick={changePassword}
          >
            修改密码
          </Button>
        </div>
      </PageSection>

      {/* The app leaves the server with 断开 on 服务器同步. */}
      {!native && (
        <PageSection>
          <button
            type="button"
            onClick={logout}
            className="w-full px-4 py-3 text-left text-sm text-error"
          >
            退出登录
          </button>
        </PageSection>
      )}
    </FullPage>
  );
}
