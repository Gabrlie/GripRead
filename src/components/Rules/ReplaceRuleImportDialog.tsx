import { useEffect, useState } from "react";
import type { ReaderService } from "../../services/contracts";
import type { ReplaceRuleImportPreview } from "../../types/generated";
import { describeError } from "../Cloud/format";
import type { ImportMethod } from "../Sources/SourceImportDialog";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { t } from "../../i18n";

const HISTORY_KEY = "gripread.replaceRuleImportHistory";

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

/**
 * Imports Legado replace rules from an address, a file, or pasted JSON, as
 * the book-source import does: the rules are listed first, those already
 * here marked, and only the chosen ones are saved.
 */
export function ReplaceRuleImportDialog({
  service,
  method,
  onDone,
  onClose,
}: {
  service: Pick<
    ReaderService,
    "fetchRuleText" | "pickRuleFile" | "previewReplaceRules" | "importReplaceRules"
  >;
  method: ImportMethod;
  onDone: (count: number) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [json, setJson] = useState<string | null>(null);
  const [preview, setPreview] = useState<ReplaceRuleImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const history = method === "network" ? readHistory() : [];

  const showPreview = (text: string) =>
    service.previewReplaceRules(text).then((result) => {
      setJson(text);
      setPreview(result);
      setChosen(new Set(result.items.flatMap((item, index) => (item.existing ? [] : [index]))));
    });
  const fail = (failure: unknown) => {
    setBusy(false);
    setError(describeError(failure));
  };

  useEffect(() => {
    if (method !== "file") return;
    setBusy(true);
    void service
      .pickRuleFile()
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
        .fetchRuleText(url)
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
    void service.importReplaceRules(json, [...chosen]).then((saved) => onDone(saved.length), fail);
  };
  const toggle = (index: number) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
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
              aria-label={t("rules.address")}
              placeholder="https://…/replaceRule.json"
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
            aria-label={t("tocRule.json")}
            rows={8}
            placeholder={t("rules.importNote")}
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
              {preview.skipped > 0 && t("rules.importSkipped", { count: preview.skipped })}
            </p>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                className="text-primary"
                onClick={() => setChosen(new Set(preview.items.map((_, index) => index)))}
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
              {preview.items.map((item, index) => (
                <li key={index}>
                  <label className="flex items-center gap-2 rounded-lg bg-surface-container-low px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={t("srcImport.one", { name: item.rule.name })}
                      checked={chosen.has(index)}
                      onChange={() => toggle(index)}
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm truncate">{item.rule.name}</span>
                      <span className="block text-[11px] text-secondary truncate font-mono">
                        {item.rule.pattern}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-[11px] ${item.existing ? "text-secondary" : "text-primary"}`}
                    >
                      {item.existing ? t("srcImport.existing") : t("srcImport.new")}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
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
