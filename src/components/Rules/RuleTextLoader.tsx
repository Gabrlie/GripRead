import { useState } from "react";
import type { ReaderService } from "../../services/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { t } from "../../i18n";
import { reportError } from "../ui/toast";

export type RuleTextService = Pick<ReaderService, "fetchRuleText" | "pickRuleFile">;

function readHistory(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function remember(key: string, url: string) {
  try {
    const history = [url, ...readHistory(key).filter((item) => item !== url)].slice(0, 10);
    localStorage.setItem(key, JSON.stringify(history));
  } catch {
    // Remembering addresses is a convenience; the import works without it.
  }
}

/**
 * Where a rule import's JSON comes from besides pasting: 网络导入 (an
 * address, the recent ones remembered under `historyKey`), 本地导入 (a
 * file), and the clipboard. The text lands in the import box for review.
 */
export function RuleTextLoader({
  service,
  historyKey,
  onText,
}: {
  service: RuleTextService;
  historyKey: string;
  onText: (text: string) => void;
}) {
  const [network, setNetwork] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const history = network ? readHistory(historyKey) : [];

  const load = (work: () => Promise<string | null>) => {
    setBusy(true);
    void work()
      .then((text) => text !== null && onText(text), reportError)
      .finally(() => setBusy(false));
  };
  const fetchUrl = (address: string) =>
    load(async () => {
      const text = await service.fetchRuleText(address);
      remember(historyKey, address);
      setNetwork(false);
      return text;
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={network ? "secondary" : "outline"}
          disabled={busy}
          onClick={() => setNetwork((value) => !value)}
        >
          {t("src.importNetwork")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => load(service.pickRuleFile)}
        >
          {t("src.importFile")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => load(() => navigator.clipboard.readText())}
        >
          {t("rules.paste")}
        </Button>
      </div>
      {network && (
        <form
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) fetchUrl(url.trim());
          }}
        >
          <div className="flex gap-2">
            <Input
              aria-label={t("rules.address")}
              inputMode="url"
              autoCapitalize="none"
              placeholder="https://…/rules.json"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !url.trim()}>
              {busy ? t("rules.fetching") : t("rules.fetch")}
            </Button>
          </div>
          {history.length > 0 && (
            <ul aria-label={t("rules.recent")} className="space-y-0.5">
              {history.map((item) => (
                <li key={item}>
                  <button
                    type="button"
                    className="w-full truncate text-left text-[11px] text-secondary hover:text-on-surface"
                    onClick={() => {
                      setUrl(item);
                      fetchUrl(item);
                    }}
                  >
                    {item}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
    </div>
  );
}
