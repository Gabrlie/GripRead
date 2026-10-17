import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { serverAccount } from "../../services/server";
import { onSignedOut, type TransportError } from "../../services/transport";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { t, useT } from "../../i18n";
import { describeError } from "../Cloud/format";

type Gate = "loading" | "setup" | "login" | "ready" | "offline";

const MIN_PASSWORD = 6;

function messageOf(error: unknown): string {
  const failure = error as Partial<TransportError>;
  return failure?.message ?? describeError(error);
}

/**
 * The web version's way in: 设置密码 on the server's first run, then 登录;
 * the app shows once signed in, and this returns when the server signs the
 * page out.
 */
export function WebGate({ children }: { children: ReactNode }) {
  useT();
  const [gate, setGate] = useState<Gate>("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = () => {
    setGate("loading");
    void serverAccount.status().then(
      (status) => setGate(!status.configured ? "setup" : status.signedIn ? "ready" : "login"),
      () => setGate("offline"),
    );
  };
  useEffect(() => {
    check();
    onSignedOut(() => setGate("login"));
  }, []);

  if (gate === "ready") return <>{children}</>;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (gate === "setup") {
      if (password.length < MIN_PASSWORD) return setError(t("gate.short", { count: MIN_PASSWORD }));
      if (password !== confirm) return setError(t("gate.mismatch"));
    }
    setBusy(true);
    void (gate === "setup" ? serverAccount.setup(password) : serverAccount.login(password))
      .then(
        () => {
          setPassword("");
          setConfirm("");
          setGate("ready");
        },
        (failure: unknown) => setError(messageOf(failure)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <main className="min-h-dvh flex items-center justify-center bg-surface text-on-surface px-4">
      <div className="w-full max-w-sm space-y-6">
        <header className="text-center space-y-1">
          <h1 className="text-xl font-semibold">{t("app.name")}</h1>
          <p className="text-xs text-secondary">{t("gate.server")}</p>
        </header>
        {gate === "loading" && (
          <p className="text-center text-sm text-secondary">{t("server.connecting")}</p>
        )}
        {gate === "offline" && (
          <div className="text-center space-y-3">
            <p className="text-sm text-secondary">{t("gate.offline")}</p>
            <Button variant="outline" onClick={check}>
              {t("common.retry")}
            </Button>
          </div>
        )}
        {(gate === "setup" || gate === "login") && (
          <form onSubmit={submit} className="space-y-3">
            {gate === "setup" && <p className="text-xs text-secondary">{t("gate.setup")}</p>}
            <Input
              type="password"
              aria-label={t("network.proxy.password")}
              placeholder={t("network.proxy.password")}
              autoComplete={gate === "setup" ? "new-password" : "current-password"}
              autoFocus
              value={password}
              onChange={(change) => setPassword(change.target.value)}
              className="h-10"
            />
            {gate === "setup" && (
              <Input
                type="password"
                aria-label={t("gate.confirm")}
                placeholder={t("gate.again")}
                autoComplete="new-password"
                value={confirm}
                onChange={(change) => setConfirm(change.target.value)}
                className="h-10"
              />
            )}
            {error && (
              <p role="alert" className="text-xs text-error">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full h-10" disabled={busy || !password}>
              {gate === "setup" ? t("gate.setPassword") : t("src.login")}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
