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

const DOH_SERVERS: [string, string][] = [
  ["ali", "阿里"],
  ["tencent", "腾讯"],
  ["cloudflare", "Cloudflare"],
  ["google", "Google"],
  ["custom", "自定义"],
];
const PROXIES: [ProxyKind, string][] = [
  ["none", "不使用"],
  ["http", "HTTP"],
  ["socks5", "SOCKS5"],
];
const PRESETS: [ConcurrencyPreset, string, string][] = [
  ["relaxed", "省心", "请求少，适合慢网络和限制严格的网站"],
  ["balanced", "均衡", "默认"],
  ["fast", "极速", "同时请求多，网站可能限流"],
  ["custom", "自定义", "自己设定下面的数值"],
];
const LIMIT_FIELDS: [keyof ConcurrencyLimits, string][] = [
  ["requests", "同时请求数"],
  ["perHost", "限流阈值（每个网站）"],
  ["windowMs", "时间窗口（毫秒）"],
  ["search", "同时搜索的书源数"],
  ["downloadBooks", "同时下载的书数"],
  ["downloadChapters", "每本书同时下载的章数"],
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
      <FullPage label="网络设置" onClose={onClose}>
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
    ? "使用代理时 DoH 不生效"
    : system.systemProxy
      ? `检测到系统代理 ${system.systemProxy}，DoH 不生效`
      : null;

  const check = (kind: "doh" | "proxy") => {
    setChecking(kind);
    void service
      .checkNetwork(draft, kind)
      .then(
        (found) => toast(`${found.detail}（${found.millis} ms）`),
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => setChecking(null));
  };

  return (
    <FullPage
      label="网络设置"
      onClose={() => {
        flush();
        onClose();
      }}
    >
      {failure && (
        <p role="alert" className="px-1 text-xs text-error">
          未保存：{failure}
        </p>
      )}
      <PageSection title="DNS over HTTPS">
        <div className="p-4 space-y-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>
              使用 DoH
              <span className="block text-[11px] text-secondary">书源域名被污染时可以打开</span>
            </span>
            <Switch
              aria-label="使用 DoH"
              checked={draft.dohEnabled}
              onCheckedChange={(dohEnabled) => set({ dohEnabled })}
            />
          </label>
          <Choice
            label="DoH 服务器"
            options={DOH_SERVERS}
            value={draft.dohServer}
            onChange={(dohServer) => set({ dohServer })}
          />
          {draft.dohEnabled && dohOff && <p className="text-[11px] text-secondary">{dohOff}</p>}
          {draft.dohServer === "custom" && (
            <Input
              aria-label="DoH 地址"
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
            {checking === "doh" ? "测试中…" : "测试 DoH"}
          </Button>
        </div>
      </PageSection>

      <PageSection title="代理">
        <div className="p-4 space-y-3">
          <Choice
            label="代理类型"
            options={PROXIES}
            value={draft.proxyKind}
            onChange={(proxyKind) => set({ proxyKind })}
          />
          {draft.proxyKind !== "none" && (
            <>
              <div className="flex gap-2">
                <Input
                  aria-label="代理地址"
                  placeholder="地址"
                  className="flex-1"
                  value={draft.proxyHost}
                  onChange={(change) => set({ proxyHost: change.target.value.trim() })}
                />
                <Input
                  aria-label="端口"
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
                  aria-label="用户名"
                  placeholder="用户名（可留空）"
                  value={draft.proxyUsername}
                  onChange={(change) => set({ proxyUsername: change.target.value })}
                />
                <Input
                  aria-label="密码"
                  type="password"
                  placeholder="密码"
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
                {checking === "proxy" ? "测试中…" : "测试代理"}
              </Button>
            </>
          )}
          <p className="text-[11px] text-secondary">
            {!ownProxy && system.systemProxy
              ? `未设置时使用系统代理 ${system.systemProxy}。`
              : "只用于书源、封面和下载，不改变系统代理。"}
          </p>
        </div>
      </PageSection>

      <PageSection title="并发">
        <div className="p-4 space-y-3">
          <Choice
            label="并发档位"
            options={PRESETS.map(([key, name]) => [key, name] as [ConcurrencyPreset, string])}
            value={draft.preset}
            onChange={(preset) => set({ preset })}
          />
          <p className="text-[11px] text-secondary">
            {PRESETS.find(([key]) => key === draft.preset)?.[2]}
          </p>
          {draft.preset === "custom" &&
            LIMIT_FIELDS.map(([key, label]) => (
              <label key={key} className="flex items-center justify-between gap-3 text-sm">
                <span>{label}</span>
                <Input
                  aria-label={label}
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
