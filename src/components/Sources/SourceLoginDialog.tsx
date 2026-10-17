import { useEffect, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type { SourceLoginForm } from "../../types/generated";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { formatDateTime, t } from "../../i18n";
import { describeError } from "../Cloud/format";
import { toast } from "../ui/toast";

/**
 * A source's `loginUi` form. 登录 saves the values and runs the source's
 * `login()`; a button row runs its own action. A web login (Android's
 * WebView) closes by itself once the source's `login()` succeeds, and the
 * last successful login is shown when the dialog opens.
 */
export function SourceLoginDialog({
  service,
  url,
  onClose,
}: {
  service: SourceService;
  url: string;
  onClose: () => void;
}) {
  const [form, setForm] = useState<SourceLoginForm | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    void service.getLoginForm(url).then(
      (loaded) => {
        setForm(loaded);
        const initial: Record<string, string> = {};
        for (const row of loaded.rows)
          if (row.kind !== "button")
            initial[row.name] = loaded.values[row.name] ?? row.defaultValue ?? "";
        setValues(initial);
      },
      (failure: unknown) => setMessage({ text: describeError(failure), error: true }),
    );
  }, [service, url]);

  const run = (action: string | null) => {
    setBusy(true);
    setMessage(null);
    void service.login({ url, values, action }).then(
      (report) => {
        setBusy(false);
        const toasts = report.logs.filter((line) => line.startsWith("[toast] "));
        const answer = report.result && report.result !== "undefined" ? report.result : "";
        if (report.loggedIn) {
          const text = t("srcLogin.success", { text: answer || t("srcLogin.done") });
          setMessage({ text, error: false });
          setForm((current) =>
            current ? { ...current, lastLogin: answer, lastLoginAt: Date.now() } : current,
          );
          toast({ text });
          return;
        }
        const web = action ? /^https?:/i.test(action) : Boolean(form?.browserOnly);
        const text =
          toasts.map((line) => line.slice(8)).join("\n") ||
          answer ||
          (web ? t("srcLogin.unconfirmed") : t("srcLogin.done"));
        setMessage({ text, error: false });
      },
      (failure: unknown) => {
        setBusy(false);
        setMessage({ text: describeError(failure), error: true });
      },
    );
  };

  const inputs = form?.rows.filter((row) => row.kind !== "button") ?? [];
  const buttons = form?.rows.filter((row) => row.kind === "button") ?? [];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm max-h-[86dvh] overflow-y-auto p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">{t("src.login")}</DialogTitle>
        </DialogHeader>
        {form?.lastLogin != null && form.lastLoginAt != null && (
          <p className="text-xs text-secondary">
            {t("srcLogin.last", {
              text: form.lastLogin || t("srcLogin.done"),
              time: formatDateTime(form.lastLoginAt),
            })}
          </p>
        )}
        {form?.browserOnly && <p className="text-sm text-secondary">{t("srcLogin.web")}</p>}
        {form && !form.browserOnly && inputs.length === 0 && buttons.length === 0 && (
          <p className="text-sm text-secondary">{t("srcLogin.script")}</p>
        )}
        {inputs.map((row) => (
          <label key={row.name} className="block space-y-1 text-xs text-secondary">
            {row.name}
            <Input
              aria-label={row.name}
              type={row.kind === "password" ? "password" : "text"}
              value={values[row.name] ?? ""}
              onChange={(event) => setValues({ ...values, [row.name]: event.target.value })}
            />
          </label>
        ))}
        {buttons.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {buttons.map((row) => (
              <Button
                key={row.name}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => run(row.action ?? null)}
              >
                {row.name}
              </Button>
            ))}
          </div>
        )}
        {message && (
          <p
            role={message.error ? "alert" : "status"}
            className={`text-xs whitespace-pre-wrap break-words ${message.error ? "text-error" : "text-secondary"}`}
          >
            {message.text}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
          {form && (
            <Button size="sm" disabled={busy} onClick={() => run(null)}>
              {busy
                ? t("srcLogin.busy")
                : form.browserOnly
                  ? t("srcLogin.openWeb")
                  : t("src.login")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
