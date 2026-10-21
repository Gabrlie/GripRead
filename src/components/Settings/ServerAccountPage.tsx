import { useEffect, useState } from "react";
import { JobsSection } from "./ServerJobsSection";
import { serverAccount, type ServerSession } from "../../services/server";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { reportError, toast } from "../ui/toast";
import { formatDate, t } from "../../i18n";
import { LoadFailed } from "../ui/LoadFailed";

function seen(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 10) return t("account.justNow");
  if (minutes < 60) return t("account.minutes", { minutes });
  if (minutes < 24 * 60) return t("account.hours", { hours: Math.round(minutes / 60) });
  return formatDate(at);
}

/**
 * The server's own settings, in 服务器账号 on the web and on the app's
 * 服务器 page while connected: 定时追更, the devices signed in (设备管理),
 * and 修改密码.
 */
export function ServerAccountSections() {
  const [sessions, setSessions] = useState<ServerSession[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    void serverAccount.sessions().then(
      (value) => {
        setSessions(value);
        setFailed(false);
      },
      (error: unknown) => {
        setFailed(true);
        reportError(error);
      },
    );
  useEffect(load, []);

  const revoke = (session: ServerSession) =>
    void serverAccount.revoke(session.id).then(() => {
      toast(t("account.revoked", { device: session.device }));
      load();
    }, reportError);

  const changePassword = () => {
    setBusy(true);
    void serverAccount
      .changePassword(current, next)
      .then(() => {
        setCurrent("");
        setNext("");
        toast(t("account.passwordChanged"));
        load();
      }, reportError)
      .finally(() => setBusy(false));
  };

  return (
    <>
      <JobsSection />
      <PageSection title={t("account.sessions")}>
        {failed && sessions === null && <LoadFailed className="py-4" onRetry={load} />}
        {sessions === null && !failed && (
          <p className="p-4 text-sm text-secondary">{t("common.loading")}</p>
        )}
        {sessions?.map((session) => (
          <div key={session.id} className="flex items-center gap-3 px-4 py-3 text-sm">
            <span className="flex-1 min-w-0">
              <span className="block truncate">
                {session.device}
                {session.current && (
                  <span className="ml-1.5 text-[11px] text-primary">{t("cloud.here")}</span>
                )}
              </span>
              <span className="block text-[11px] text-secondary">{seen(session.lastSeen)}</span>
            </span>
            {!session.current && (
              <Button size="sm" variant="ghost" onClick={() => revoke(session)}>
                {t("account.revoke")}
              </Button>
            )}
          </div>
        ))}
      </PageSection>

      <PageSection title={t("account.changePassword")}>
        <div className="p-4 space-y-2">
          <Input
            type="password"
            aria-label={t("account.current")}
            placeholder={t("account.current")}
            autoComplete="current-password"
            value={current}
            onChange={(change) => setCurrent(change.target.value)}
          />
          <Input
            type="password"
            aria-label={t("account.next")}
            placeholder={t("account.next.placeholder")}
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
            {t("account.changePassword")}
          </Button>
        </div>
      </PageSection>
    </>
  );
}

/** 服务器账号 in the web version: the server's settings and 退出登录. */
export function ServerAccountPage({ onClose }: { onClose: () => void }) {
  const logout = () => void serverAccount.logout().then(() => location.reload(), reportError);

  return (
    <FullPage label={t("settings.account")} onClose={onClose}>
      <ServerAccountSections />
      <PageSection>
        <button
          type="button"
          onClick={logout}
          className="w-full px-4 py-3 text-left text-sm text-error"
        >
          {t("account.logout")}
        </button>
      </PageSection>
    </FullPage>
  );
}
