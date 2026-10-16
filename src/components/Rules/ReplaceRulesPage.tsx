import { useEffect, useState } from "react";
import type { ReaderService } from "../../services/contracts";
import { copyText } from "../../services/system";
import type { ReplaceRule } from "../../types/generated";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { usePageLayer } from "../Layout/use-page-layer";
import { ReplaceRuleImportDialog } from "./ReplaceRuleImportDialog";
import type { ImportMethod } from "../Sources/SourceImportDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { t } from "../../i18n";

export const EMPTY_REPLACE_RULE: ReplaceRule = {
  id: "",
  name: "",
  group: "",
  pattern: "",
  replacement: "",
  isRegex: true,
  scope: "",
  enabled: true,
  serial: 0,
};

/**
 * Legado's 替换净化 rule list: enable, edit, test, reorder, delete, and
 * import or export rules shared by every book. `onChanged` reports that the
 * text of open books may need the rules applied again. Opened from a book,
 * it also shows that book's own switch.
 */
export function ReplaceRulesPage({
  service,
  book,
  onChanged,
  onClose,
  backCloses = false,
}: {
  service: ReaderService;
  /** The Android back gesture closes the page (outside the reader, which handles it). */
  backCloses?: boolean;
  /** This book's own 替换净化 switch. */
  book?: { enabled: boolean; onToggle: (enabled: boolean) => void };
  onChanged?: () => void;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<ReplaceRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ReplaceRule | null>(null);
  const [importing, setImporting] = useState<ImportMethod | null>(null);
  const layer = usePageLayer(backCloses ? onClose : () => undefined);
  const load = () =>
    service.listReplaceRules().then(setRules, (failure: unknown) => setError(String(failure)));
  useEffect(() => {
    void load();
  }, [service]);
  const change = (action: () => Promise<unknown>, done?: string) =>
    void action()
      .then(load)
      .then(
        () => {
          setError(null);
          if (done) toast(done);
          onChanged?.();
        },
        (failure: unknown) => setError(String(failure)),
      );
  const move = (index: number, step: number) => {
    const ids = rules.map((rule) => rule.id);
    const target = index + step;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    change(() => service.orderReplaceRules(ids));
  };
  return (
    <div
      ref={backCloses ? layer : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.replace")}
      data-open=""
      className="fixed inset-0 z-[45] bg-surface text-on-surface flex flex-col pt-safe pb-safe"
    >
      <header className="shrink-0 h-14 px-2 flex items-center gap-1 border-b border-surface-variant/30 max-w-3xl mx-auto w-full">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("common.back")}
          className="h-9 w-9 rounded-full text-secondary"
          onClick={onClose}
        >
          <Icon name="arrow_back" size={20} />
        </Button>
        <h1 className="flex-1 font-title-editorial text-base font-semibold">
          {t("settings.replace")}
        </h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("rules.add")}
          className="h-9 w-9 rounded-full text-secondary"
          onClick={() => setEditing(EMPTY_REPLACE_RULE)}
        >
          <Icon name="add" size={20} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("reader.more")}
            className="h-9 w-9 rounded-full inline-flex items-center justify-center text-secondary hover:bg-surface-container"
          >
            <Icon name="more_vert" size={19} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => setImporting("network")}>
              <Icon name="public" size={15} />
              {t("src.importNetwork")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setImporting("file")}>
              <Icon name="description" size={15} />
              {t("src.importFile")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setImporting("paste")}>
              <Icon name="content_paste" size={15} />
              {t("src.importPaste")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!rules.length}
              onClick={() =>
                void service
                  .exportReplaceRules()
                  .then(copyText)
                  .then(
                    () => toast(t("tocRule.exported")),
                    (failure: unknown) => setError(String(failure)),
                  )
              }
            >
              <Icon name="share" size={15} />
              {t("common.export")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full p-3 space-y-2">
          {book && (
            <label className="flex items-center justify-between gap-3 rounded-xl bg-surface-container-low px-4 py-3 text-sm">
              <span>
                {t("rules.bookSwitch")}
                <span className="block text-[11px] text-secondary">{t("rules.bookNote")}</span>
              </span>
              <Switch
                aria-label={t("rules.bookSwitch")}
                checked={book.enabled}
                onCheckedChange={book.onToggle}
              />
            </label>
          )}
          {error && (
            <p role="alert" className="text-xs text-error break-words px-1">
              {error}
            </p>
          )}
          {rules.length === 0 && (
            <p className="text-sm text-secondary px-1 py-6 text-center">{t("rules.none")}</p>
          )}
          {rules.map((rule, index) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 rounded-xl bg-surface-container-low pl-3 pr-1 py-2"
            >
              <Switch
                aria-label={t("src.enableOne", { name: rule.name })}
                checked={rule.enabled}
                onCheckedChange={(enabled) =>
                  change(() => service.saveReplaceRule({ ...rule, enabled }))
                }
              />
              <button
                type="button"
                className="flex-1 min-w-0 text-left px-1"
                onClick={() => setEditing(rule)}
              >
                <span className="block text-sm truncate">
                  {rule.name}
                  {rule.group && (
                    <span className="ml-2 text-[11px] text-secondary">{rule.group}</span>
                  )}
                </span>
                <span className="block text-[11px] text-secondary truncate font-mono">
                  {rule.pattern} → {rule.replacement || t("rules.removed")}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("tools.up", { name: rule.name })}
                className="h-8 w-8 text-secondary"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <Icon name="arrow_upward" size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("tools.down", { name: rule.name })}
                className="h-8 w-8 text-secondary"
                disabled={index === rules.length - 1}
                onClick={() => move(index, 1)}
              >
                <Icon name="arrow_downward" size={15} />
              </Button>
            </div>
          ))}
        </div>
      </div>
      {editing && (
        <ReplaceRuleEditor
          rule={editing}
          service={service}
          onSave={(rule) =>
            service.saveReplaceRule(rule).then(() => {
              setEditing(null);
              change(async () => undefined);
            })
          }
          onDelete={
            editing.id
              ? () =>
                  service.deleteReplaceRules([editing.id]).then(() => {
                    setEditing(null);
                    change(async () => undefined);
                  })
              : undefined
          }
          onClose={() => setEditing(null)}
        />
      )}
      {importing && (
        <ReplaceRuleImportDialog
          service={service}
          method={importing}
          onDone={(count) => {
            setImporting(null);
            change(
              async () => undefined,
              count ? t("tocRule.imported", { count }) : t("tocRule.noneNew"),
            );
          }}
          onClose={() => setImporting(null)}
        />
      )}
    </div>
  );
}

/** Adds or edits one rule, with a test against sample text. */
export function ReplaceRuleEditor({
  rule: initial,
  service,
  onSave,
  onDelete,
  onClose,
}: {
  rule: ReplaceRule;
  service: ReaderService;
  onSave: (rule: ReplaceRule) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}) {
  const [rule, setRule] = useState(initial);
  const [sample, setSample] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const field = (
    label: string,
    key: "name" | "group" | "pattern" | "replacement" | "scope",
    hint?: string,
  ) => (
    <label className="block space-y-1 text-xs text-secondary">
      {label}
      <Input
        value={rule[key]}
        placeholder={hint}
        className={key === "pattern" || key === "replacement" ? "font-mono" : undefined}
        onChange={(event) => setRule({ ...rule, [key]: event.target.value })}
      />
    </label>
  );
  const fail = (failure: unknown) => setError(String(failure));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[86dvh] overflow-y-auto p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {initial.id ? t("rules.edit") : t("rules.addTitle")}
          </DialogTitle>
        </DialogHeader>
        {field(t("style.name"), "name")}
        {field(t("detail.group"), "group", t("rules.optional"))}
        {field(
          t("rules.pattern"),
          "pattern",
          rule.isRegex ? t("search.regex") : t("rules.patternText"),
        )}
        {field(
          t("rules.replacement"),
          "replacement",
          rule.isRegex ? t("rules.replacementRegex") : t("rules.replacementText"),
        )}
        <label className="flex items-center justify-between text-xs">
          {t("rules.useRegex")}
          <Switch
            aria-label={t("rules.useRegex")}
            checked={rule.isRegex}
            onCheckedChange={(isRegex) => setRule({ ...rule, isRegex })}
          />
        </label>
        {field(t("rules.scope"), "scope", t("rules.scopeNote"))}
        <div className="space-y-1.5 rounded-xl bg-surface-container-low p-3">
          <textarea
            aria-label={t("rules.sample")}
            placeholder={t("rules.samplePlaceholder")}
            rows={3}
            value={sample}
            onChange={(event) => setSample(event.target.value)}
            className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm outline-none resize-y"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!sample || !rule.pattern}
            onClick={() =>
              void service.testReplaceRule(rule, sample).then((value) => {
                setError(null);
                setResult(value);
              }, fail)
            }
          >
            {t("tocRule.test")}
          </Button>
          {result !== null && (
            <p className="text-sm whitespace-pre-wrap break-words" aria-label={t("rules.result")}>
              {result || t("rules.emptyResult")}
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-error break-words">
            {error}
          </p>
        )}
        <div className="flex justify-between gap-2">
          {onDelete ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-error"
              onClick={() => void onDelete().catch(fail)}
            >
              {t("common.delete")}
            </Button>
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!rule.name.trim() || !rule.pattern}
              onClick={() => void onSave(rule).catch(fail)}
            >
              {t("common.save")}
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
