import { useEffect, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type { SourceImportPreview, SourceImportStatus } from "../../types/generated";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { t } from "../../i18n";
import { describeError } from "../Cloud/format";

export type ImportMethod = "network" | "file" | "paste";

const HISTORY_KEY = "gripread.sourceImportHistory";

function readHistory(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function remember(url: string) {
  try {
    const history = [url, ...readHistory().filter((item) => item !== url)].slice(0, 10);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Remembering addresses is a convenience; the import works without it.
  }
}

const STATUS_LABEL: Record<SourceImportStatus, string> = {
  get new() {
    return t("srcImport.new");
  },
  get update() {
    return t("srcImport.update");
  },
  get existing() {
    return t("srcImport.existing");
  },
};

/**
 * Imports Legado sources from an address, a file, or pasted JSON: the
 * sources are listed first with what importing would do, and only the
 * chosen ones are saved.
 */
export function SourceImportDialog({
  service,
  method,
  initialUrl,
  subscribed = false,
  onDone,
  onClose,
}: {
  service: SourceService;
  method: ImportMethod;
  /** An address to fetch at once (a 书源订阅's update). */
  initialUrl?: string;
  /** The address is a subscription already, so 保存为订阅 is not offered. */
  subscribed?: boolean;
  onDone: (count: number) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState(initialUrl ?? "");
  const [subscribe, setSubscribe] = useState(false);
  const [json, setJson] = useState<string | null>(null);
  const [preview, setPreview] = useState<SourceImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [keepName, setKeepName] = useState(true);
  const [keepGroup, setKeepGroup] = useState(true);
  const [keepEnabled, setKeepEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = method === "network" ? readHistory() : [];

  const showPreview = (text: string) =>
    service.previewImport(text).then((result) => {
      setJson(text);
      setPreview(result);
      setChosen(
        new Set(result.items.filter((item) => item.status !== "existing").map((item) => item.url)),
      );
    });

  const fail = (failure: unknown) => {
    setBusy(false);
    setError(describeError(failure));
  };

  // A subscription's update fetches its address at once.
  useEffect(() => {
    if (method === "network" && initialUrl) load();
  }, []);

  useEffect(() => {
    if (method !== "file") return;
    setBusy(true);
    void service
      .pickSourceFile()
      .then((text) => {
        if (text === null) {
          onClose();
          return;
        }
        return showPreview(text).then(() => setBusy(false));
      })
      .catch(fail);
  }, [method, service]);

  const load = () => {
    setBusy(true);
    setError(null);
    if (method === "network") {
      const url = input.trim();
      void service
        .fetchText(url)
        .then((text) => {
          remember(url);
          return showPreview(text);
        })
        .then(() => setBusy(false), fail);
    } else {
      void showPreview(input).then(() => setBusy(false), fail);
    }
  };

  const save = () => {
    if (!json) return;
    setBusy(true);
    void service
      .importSources({
        json,
        urls: [...chosen],
        keepName,
        keepGroup,
        keepEnabled,
      })
      .then(async (saved) => {
        if (subscribe && method === "network" && input.trim())
          await service
            .saveSubscription({
              id: "",
              name: "",
              url: input.trim(),
              updatedAt: null,
              imported: null,
            })
            .then((list) => {
              const added = list.find((item) => item.url === input.trim());
              return added && service.subscriptionImported(added.id, saved.length);
            })
            .catch(() => undefined);
        onDone(saved.length);
      }, fail);
  };

  const toggle = (url: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const title = {
    network: t("src.importNetwork"),
    file: t("src.importFile"),
    paste: t("src.importPaste"),
  }[method];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[86dvh] p-5 gap-3 flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">{title}</DialogTitle>
        </DialogHeader>
        {!preview && method === "network" && (
          <div className="space-y-2">
            <Input
              aria-label={t("srcImport.address")}
              placeholder="https://…/bookSource.json"
              inputMode="url"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            {history.length > 0 && (
              <ul className="space-y-1" aria-label={t("srcImport.history")}>
                {history.map((url) => (
                  <li key={url}>
                    <button
                      type="button"
                      className="w-full text-left text-xs text-secondary truncate px-1 py-1 hover:text-on-surface"
                      onClick={() => setInput(url)}
                    >
                      <Icon name="link" size={12} className="inline mr-1" />
                      {url}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!preview && method === "paste" && (
          <textarea
            aria-label={t("srcEdit.json")}
            rows={8}
            placeholder={t("srcImport.placeholder")}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono outline-none resize-y"
          />
        )}
        {!preview && method === "file" && busy && (
          <p role="status" className="text-sm text-secondary">
            {t("srcImport.reading")}
          </p>
        )}
        {preview && (
          <div className="flex-1 min-h-0 flex flex-col gap-2">
            <p className="text-xs text-secondary">
              {t("srcImport.count", { total: preview.items.length, chosen: chosen.size })}
              {preview.skipped > 0 && t("srcImport.skipped", { count: preview.skipped })}
              {preview.invalid.length > 0 &&
                t("srcImport.invalid", { count: preview.invalid.length })}
            </p>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                className="text-primary"
                onClick={() => setChosen(new Set(preview.items.map((item) => item.url)))}
              >
                {t("downloads.selectAll")}
              </button>
              <button type="button" className="text-primary" onClick={() => setChosen(new Set())}>
                {t("srcImport.selectNone")}
              </button>
            </div>
            <ul
              className="flex-1 min-h-0 overflow-y-auto space-y-1"
              aria-label={t("srcImport.list")}
            >
              {preview.items.map((item) => (
                <li key={item.url}>
                  <label className="flex items-center gap-2 rounded-lg bg-surface-container-low px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={t("srcImport.one", { name: item.name })}
                      checked={chosen.has(item.url)}
                      onChange={() => toggle(item.url)}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm truncate">{item.name}</span>
                      <span className="block text-[11px] text-secondary truncate">{item.url}</span>
                    </span>
                    <span
                      className={`shrink-0 text-[11px] ${
                        item.status === "existing" ? "text-secondary" : "text-primary"
                      }`}
                    >
                      {STATUS_LABEL[item.status]}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {preview.invalid.length > 0 && (
              <details className="text-[11px] text-secondary">
                <summary>{t("srcImport.invalidList")}</summary>
                <ul className="list-disc pl-4">
                  {preview.invalid.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              </details>
            )}
            <div className="space-y-1.5 rounded-xl bg-surface-container-low p-3 text-xs">
              {(
                [
                  [t("srcImport.keepName"), keepName, setKeepName],
                  [t("srcImport.keepGroup"), keepGroup, setKeepGroup],
                  [t("srcImport.keepEnabled"), keepEnabled, setKeepEnabled],
                  ...(method === "network" && !subscribed
                    ? [[t("srcSub.saveAs"), subscribe, setSubscribe]]
                    : []),
                ] as [string, boolean, (value: boolean) => void][]
              ).map(([label, value, set]) => (
                <label key={label} className="flex items-center justify-between">
                  {label}
                  <Switch aria-label={label} checked={value} onCheckedChange={set} />
                </label>
              ))}
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-error break-words">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          {preview ? (
            <Button size="sm" disabled={busy || chosen.size === 0} onClick={save}>
              {t("srcImport.importCount", { count: chosen.size })}
            </Button>
          ) : (
            method !== "file" && (
              <Button size="sm" disabled={busy || !input.trim()} onClick={load}>
                {busy ? t("srcImport.busy") : t("srcImport.next")}
              </Button>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
