import { useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";
import type {
  ConcurrencyLimits,
  ConcurrencyPreset,
  NetworkSettings,
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

/**
 * 网络设置: DNS over HTTPS, a proxy the app's requests go through (the
 * device's own stays as it is), and how many requests run at once.
 */
export function NetworkSettingsPage({ onClose }: { onClose: () => void }) {
  const runtime = useRuntime();
  const service = runtime.services.settings;
  const [saved, setSaved] = useState<NetworkSettings | null>(null);
  const [draft, setDraft] = useState<NetworkSettings | null>(null);
  const [checking, setChecking] = useState<"doh" | "proxy" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void service.getNetwork().then(
      (value) => {
        if (!active) return;
        setSaved(value);
        setDraft(value);
      },
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
    return () => {
      active = false;
    };
  }, [service]);

  if (!draft)
    return (
      <FullPage label="网络设置" onClose={onClose}>
        {null}
      </FullPage>
    );
  const set = (patch: Partial<NetworkSettings>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const check = (kind: "doh" | "proxy") => {
    setChecking(kind);
    void service
      .checkNetwork(draft, kind)
      .then(
        (found) => toast(`${found.detail}（${found.millis} ms）`),
        (failure: unknown) => toast({ text: describeError(failure), error: true }),
      )
      .finally(() => setChecking(null));
  };

  const save = () => {
    setBusy(true);
    void service
      .saveNetwork(draft)
      .then(
        (value) => {
          setSaved(value);
          setDraft(value);
          toast("网络设置已保存");
        },
        (failure: unknown) => toast({ text: describeError(failure), error: true }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <FullPage
      label="网络设置"
      onClose={onClose}
      actions={
        <Button size="sm" variant="ghost" disabled={!dirty || busy} onClick={save}>
          保存
        </Button>
      }
    >
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
          <p className="text-[11px] text-secondary">只用于书源、封面和下载，不改变系统代理。</p>
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
