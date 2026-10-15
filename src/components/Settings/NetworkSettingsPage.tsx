import { useCallback, useEffect, useRef, useState } from "react";
import { useRuntime } from "../../application/runtime";
import type {
  ConcurrencyLimits,
  ConcurrencyPreset,
  NetworkSettings,
  NetworkState,
  ProxyKind,
} from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { t, useT } from "../../i18n";

const dohServers = (): [string, string][] => [
  ["ali", t("network.doh.ali")],
  ["tencent", t("network.doh.tencent")],
  ["cloudflare", "Cloudflare"],
  ["google", "Google"],
  ["custom", t("network.doh.custom")],
];
const proxies = (): [ProxyKind, string][] => [
  ["none", t("network.proxy.none")],
  ["http", "HTTP"],
  ["socks5", "SOCKS5"],
];
const PRESETS: ConcurrencyPreset[] = ["relaxed", "balanced", "fast", "custom"];
const LIMIT_FIELDS: (keyof ConcurrencyLimits)[] = [
  "requests",
  "perHost",
  "windowMs",
  "search",
  "downloadBooks",
  "downloadChapters",
];

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex gap-1.5 bg-surface-container p-1 rounded-lg"
    >
      {options.map(([key, name]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          className={`flex-1 h-8 rounded-md text-xs ${value === key ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** Typing waits this long before the change is saved. */
const SAVE_DELAY = 500;

/**
 * 网络设置: DNS over HTTPS, a proxy the app's requests go through (the
 * device's own stays as it is), and how many requests run at once. Changes
 * save by themselves, like the other settings.
 */
export function NetworkSettingsPage({ onClose }: { onClose: () => void }) {
  useT();
  const runtime = useRuntime();
  const service = runtime.services.settings;
  const [draft, setDraft] = useState<NetworkSettings | null>(null);
  const [system, setSystem] = useState<NetworkState>({});
  const [checking, setChecking] = useState<"doh" | "proxy" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const pending = useRef<NetworkSettings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<unknown>>(Promise.resolve());

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const value = pending.current;
    pending.current = null;
    if (!value) return;
    // One save at a time, in the order the changes were made.
    saving.current = saving.current.then(() =>
      service.saveNetwork(value).then(
        () => setFailure(null),
        (error: unknown) => setFailure(describeError(error)),
      ),
    );
  }, [service]);

  useEffect(() => {
    let active = true;
    void service.getNetwork().then(
      (value) => {
        if (active) setDraft(value);
      },
      (error: unknown) => toast({ text: describeError(error), error: true }),
    );
    void service.networkState().then(
      (value) => {
        if (active) setSystem(value);
      },
      () => undefined,
    );
    return () => {
      active = false;
      flush();
    };
  }, [service, flush]);

  if (!draft)
    return (
      <FullPage label={t("network.title")} onClose={onClose}>
        {null}
      </FullPage>
    );
  const set = (patch: Partial<NetworkSettings>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY);
  };
  const ownProxy = draft.proxyKind !== "none" && draft.proxyHost.trim() !== "";
  const dohOff = ownProxy
    ? t("network.dohOffProxy")
    : system.systemProxy
      ? t("network.dohOffSystem", { proxy: system.systemProxy })
      : null;

  const check = (kind: "doh" | "proxy") => {
    setChecking(kind);
    void service
      .checkNetwork(draft, kind)
      .then(
        (found) => toast(`${found.detail} (${found.millis} ms)`),
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => setChecking(null));
  };

  return (
    <FullPage
      label={t("network.title")}
      onClose={() => {
        flush();
        onClose();
      }}
    >
      {failure && (
        <p role="alert" className="px-1 text-xs text-error">
          {t("network.unsaved", { error: failure })}
        </p>
      )}
      <PageSection title="DNS over HTTPS">
        <div className="p-4 space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              {t("network.doh")}
              <span className="block text-[11px] text-secondary">{t("network.doh.note")}</span>
            </span>
            <Switch
              aria-label={t("network.doh")}
              checked={draft.dohEnabled}
              onCheckedChange={(dohEnabled) => set({ dohEnabled })}
            />
          </label>
          <Choice
            label={t("network.doh.server")}
            options={dohServers()}
            value={draft.dohServer}
            onChange={(dohServer) => set({ dohServer })}
          />
          {draft.dohEnabled && dohOff && <p className="text-[11px] text-secondary">{dohOff}</p>}
          {draft.dohServer === "custom" && (
            <Input
              aria-label={t("network.doh.address")}
              placeholder="https://…/dns-query"
              value={draft.dohCustomUrl}
              onChange={(change) => set({ dohCustomUrl: change.target.value })}
            />
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={checking !== null}
            onClick={() => check("doh")}
          >
            {checking === "doh" ? t("network.testing") : t("network.doh.test")}
          </Button>
        </div>
      </PageSection>

      <PageSection title={t("network.proxy")}>
        <div className="p-4 space-y-3">
          <Choice
            label={t("network.proxy.kind")}
            options={proxies()}
            value={draft.proxyKind}
            onChange={(proxyKind) => set({ proxyKind })}
          />
          {draft.proxyKind !== "none" && (
            <>
              <div className="flex gap-2">
                <Input
                  aria-label={t("network.proxy.host")}
                  placeholder={t("network.proxy.hostPlaceholder")}
                  className="flex-1"
                  value={draft.proxyHost}
                  onChange={(change) => set({ proxyHost: change.target.value.trim() })}
                />
                <Input
                  aria-label={t("network.proxy.port")}
                  inputMode="numeric"
                  className="w-24"
                  value={String(draft.proxyPort)}
                  onChange={(change) =>
                    set({
                      proxyPort: Math.min(
                        65535,
                        Number(change.target.value.replace(/\D/g, "")) || 0,
                      ),
                    })
                  }
                />
              </div>
              <div className="flex gap-2">
                <Input
                  aria-label={t("network.proxy.user")}
                  placeholder={t("network.proxy.userPlaceholder")}
                  value={draft.proxyUsername}
                  onChange={(change) => set({ proxyUsername: change.target.value })}
                />
                <Input
                  aria-label={t("network.proxy.password")}
                  type="password"
                  placeholder={t("network.proxy.password")}
                  value={draft.proxyPassword}
                  onChange={(change) => set({ proxyPassword: change.target.value })}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={checking !== null}
                onClick={() => check("proxy")}
              >
                {checking === "proxy" ? t("network.testing") : t("network.proxy.test")}
              </Button>
            </>
          )}
          <p className="text-[11px] text-secondary">
            {!ownProxy && system.systemProxy
              ? t("network.proxy.system", { proxy: system.systemProxy })
              : t("network.proxy.scope")}
          </p>
        </div>
      </PageSection>

      <PageSection title={t("network.concurrency")}>
        <div className="p-4 space-y-3">
          <Choice
            label={t("network.concurrency.preset")}
            options={PRESETS.map((key) => [key, t(`network.preset.${key}`)])}
            value={draft.preset}
            onChange={(preset) => set({ preset })}
          />
          <p className="text-[11px] text-secondary">{t(`network.preset.${draft.preset}.note`)}</p>
          {draft.preset === "custom" &&
            LIMIT_FIELDS.map((key) => (
              <label key={key} className="flex items-center justify-between gap-3 text-sm">
                <span>{t(`network.limit.${key}`)}</span>
                <Input
                  aria-label={t(`network.limit.${key}`)}
                  inputMode="numeric"
                  className="w-24 text-right tabular-nums"
                  value={String(draft.custom[key])}
                  onChange={(change) =>
                    set({
                      custom: {
                        ...draft.custom,
                        [key]: Number(change.target.value.replace(/\D/g, "")) || 0,
                      },
                    })
                  }
                />
              </label>
            ))}
        </div>
      </PageSection>
    </FullPage>
  );
}
