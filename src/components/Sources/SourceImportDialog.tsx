import { useEffect, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type { SourceImportPreview, SourceImportStatus } from "../../types/generated";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

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
  new: "新增",
  update: "更新",
  existing: "已有",
};

/**
 * Imports Legado sources from an address, a file, or pasted JSON: the
 * sources are listed first with what importing would do, and only the
 * chosen ones are saved.
 */
export function SourceImportDialog({
  service,
  method,
  onDone,
  onClose,
}: {
  service: SourceService;
  method: ImportMethod;
  onDone: (count: number) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
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
    setError(String(failure));
  };

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
      .then((saved) => onDone(saved.length), fail);
  };

  const toggle = (url: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const title = { network: "网络导入", file: "本地导入", paste: "粘贴导入" }[method];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[86dvh] p-5 gap-3 flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">{title}</DialogTitle>
        </DialogHeader>
        {!preview && method === "network" && (
          <div className="space-y-2">
            <Input
              aria-label="书源地址"
              placeholder="https://…/bookSource.json"
              inputMode="url"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            {history.length > 0 && (
              <ul className="space-y-1" aria-label="导入过的地址">
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
            aria-label="书源 JSON"
            rows={8}
            placeholder="粘贴阅读（Legado）书源 JSON，单个书源或数组都可以"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono outline-none resize-y"
          />
        )}
        {!preview && method === "file" && busy && (
          <p role="status" className="text-sm text-secondary">
            正在读取文件…
          </p>
        )}
        {preview && (
          <div className="flex-1 min-h-0 flex flex-col gap-2">
            <p className="text-xs text-secondary">
              共 {preview.items.length} 个书源，已选 {chosen.size} 个
              {preview.skipped > 0 && `；跳过 ${preview.skipped} 个音频、图片或文件书源`}
              {preview.invalid.length > 0 && `；${preview.invalid.length} 个无法识别`}
            </p>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                className="text-primary"
                onClick={() => setChosen(new Set(preview.items.map((item) => item.url)))}
              >
                全选
              </button>
              <button type="button" className="text-primary" onClick={() => setChosen(new Set())}>
                全不选
              </button>
            </div>
            <ul className="flex-1 min-h-0 overflow-y-auto space-y-1" aria-label="待导入的书源">
              {preview.items.map((item) => (
                <li key={item.url}>
                  <label className="flex items-center gap-2 rounded-lg bg-surface-container-low px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`导入 ${item.name}`}
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
                <summary>无法识别的条目</summary>
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
                  ["保留本地书源名称", keepName, setKeepName],
                  ["保留本地分组", keepGroup, setKeepGroup],
                  ["保留本地启用状态", keepEnabled, setKeepEnabled],
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
            取消
          </Button>
          {preview ? (
            <Button size="sm" disabled={busy || chosen.size === 0} onClick={save}>
              导入 {chosen.size} 个
            </Button>
          ) : (
            method !== "file" && (
              <Button size="sm" disabled={busy || !input.trim()} onClick={load}>
                {busy ? "读取中…" : "下一步"}
              </Button>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
