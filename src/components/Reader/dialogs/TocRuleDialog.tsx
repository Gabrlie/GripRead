import { copyText } from "../../../services/system";
import { useState } from "react";
import type { BookTocSettings, TxtTocRule } from "../../../types/generated";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/toast";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { RuleTextLoader, type RuleTextService } from "../../Rules/RuleTextLoader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { t } from "../../../i18n";

interface TocRuleDialogProps {
  rules: TxtTocRule[];
  settings: BookTocSettings;
  /** The rule automatic detection chose, shown next to 自动识别. */
  detectedName: string;
  busy: boolean;
  onSelect: (ruleId: string | null) => void;
  onToggleSplit: () => void;
  onSave: (rule: TxtTocRule) => Promise<unknown>;
  onDelete: (rule: TxtTocRule) => Promise<unknown>;
  onOrder: (ids: string[]) => Promise<unknown>;
  onImport: (json: string) => Promise<TxtTocRule[] | undefined>;
  onExport: () => Promise<string>;
  onTest: (pattern: string, sample: string) => Promise<string[]>;
  /** 网络导入 and 本地导入 for the import view. */
  loader?: RuleTextService;
  onClose: () => void;
}

export const NEW_TOC_RULE: TxtTocRule = {
  id: "",
  name: "",
  pattern: "",
  example: "",
  serial: 0,
  enabled: true,
  builtin: false,
};

type View = { kind: "list" } | { kind: "edit"; rule: TxtTocRule } | { kind: "import" };

/**
 * Legado's TxtTocRuleDialog: pick this book's rule or automatic detection,
 * enable rules for automatic detection, reorder, edit and test, and exchange
 * rules with Legado as JSON.
 */
export function TocRuleDialog(props: TocRuleDialogProps) {
  const [view, setView] = useState<View>({ kind: "list" });
  const report = (work: Promise<unknown>, done?: string) =>
    work.then(
      () => done && toast(done),
      (error: unknown) => toast({ text: String(error), error: true }),
    );
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-lg h-[70dvh] flex flex-col gap-2.5 p-4">
        <DialogHeader>
          <DialogTitle>
            {view.kind === "edit"
              ? view.rule.id
                ? t("tocRule.edit")
                : t("tocRule.new")
              : view.kind === "import"
                ? t("tocRule.import")
                : t("settings.toc")}
          </DialogTitle>
          <DialogDescription>
            {view.kind === "list"
              ? t("tocRule.listNote")
              : view.kind === "import"
                ? t("tocRule.importNote")
                : t("tocRule.editNote")}
          </DialogDescription>
        </DialogHeader>
        {view.kind === "list" && (
          <RuleList
            {...props}
            report={report}
            onEdit={(rule) => setView({ kind: "edit", rule })}
            onShowImport={() => setView({ kind: "import" })}
          />
        )}
        {view.kind === "edit" && (
          <TocRuleEditor
            rule={view.rule}
            busy={props.busy}
            onTest={props.onTest}
            onCancel={() => setView({ kind: "list" })}
            onSave={(rule) =>
              props.onSave(rule).then(
                () => {
                  toast(rule.id ? t("tocRule.saved") : t("tocRule.added"));
                  setView({ kind: "list" });
                },
                (error: unknown) => toast({ text: String(error), error: true }),
              )
            }
          />
        )}
        {view.kind === "import" && (
          <TocRuleImport
            busy={props.busy}
            loader={props.loader}
            onCancel={() => setView({ kind: "list" })}
            onImport={(json) =>
              props.onImport(json).then(
                (added) => {
                  toast(
                    added?.length
                      ? t("tocRule.imported", { count: added.length })
                      : t("tocRule.noneNew"),
                  );
                  setView({ kind: "list" });
                },
                (error: unknown) => toast({ text: String(error), error: true }),
              )
            }
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function RuleList({
  rules,
  settings,
  detectedName,
  busy,
  onSelect,
  onToggleSplit,
  onSave,
  onDelete,
  onOrder,
  onExport,
  report,
  onEdit,
  onShowImport,
}: TocRuleDialogProps & {
  report: (work: Promise<unknown>, done?: string) => void;
  onEdit: (rule: TxtTocRule) => void;
  onShowImport: () => void;
}) {
  const move = (index: number, offset: -1 | 1) => {
    const ids = rules.map((rule) => rule.id);
    const target = index + offset;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    report(onOrder(ids));
  };
  const radio = (selected: boolean) => (
    <span
      aria-hidden="true"
      className={`h-4 w-4 rounded-full border-2 shrink-0 ${selected ? "border-primary bg-primary shadow-[inset_0_0_0_2px_var(--color-surface)]" : "border-outline-variant"}`}
    />
  );
  return (
    <>
      <div
        className="max-h-[min(38dvh,20rem)] min-h-0 overflow-y-auto overscroll-contain -mx-1 px-1 space-y-1"
        role="radiogroup"
        aria-label={t("tocRule.bookRule")}
      >
        <button
          role="radio"
          aria-checked={settings.ruleId === null}
          disabled={busy}
          className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-surface-container disabled:opacity-60"
          onClick={() => onSelect(null)}
        >
          {radio(settings.ruleId === null)}
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium">{t("reader.encoding.auto")}</span>
            <span className="block text-[11px] text-secondary truncate">
              {settings.ruleId === null && detectedName
                ? t("tocRule.detected", { name: detectedName })
                : t("tocRule.autoNote")}
            </span>
          </span>
        </button>
        {rules.map((rule, index) => (
          <div
            key={rule.id}
            className="flex items-center gap-1 rounded-xl hover:bg-surface-container/60 pr-1"
          >
            <button
              role="radio"
              aria-checked={settings.ruleId === rule.id}
              disabled={busy}
              className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2 text-left disabled:opacity-60"
              onClick={() => onSelect(rule.id)}
            >
              {radio(settings.ruleId === rule.id)}
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">{rule.name}</span>
                <span className="block text-[11px] text-secondary truncate">
                  {rule.example.split("\n")[0] ||
                    (rule.pattern ? rule.pattern : t("tocRule.byLength"))}
                </span>
              </span>
            </button>
            <Switch
              aria-label={t("tocRule.enabled", { name: rule.name })}
              size="sm"
              checked={rule.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => report(onSave({ ...rule, enabled }))}
            />
            <Button
              aria-label={t("tools.up", { name: rule.name })}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-secondary"
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            >
              <Icon name="arrow_upward" size={14} />
            </Button>
            <Button
              aria-label={t("tools.down", { name: rule.name })}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-secondary"
              disabled={busy || index === rules.length - 1}
              onClick={() => move(index, 1)}
            >
              <Icon name="arrow_downward" size={14} />
            </Button>
            <Button
              aria-label={t("style.editNamed", { name: rule.name })}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-secondary"
              disabled={busy}
              onClick={() => onEdit(rule)}
            >
              <Icon name="edit" size={14} />
            </Button>
            {!rule.builtin && (
              <Button
                aria-label={t("shelf.bin.deleteBook", { title: rule.name })}
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-secondary"
                disabled={busy}
                onClick={() => report(onDelete(rule), t("tocRule.deleted"))}
              >
                <Icon name="delete" size={14} />
              </Button>
            )}
          </div>
        ))}
      </div>
      <label className="flex items-center justify-between gap-3 text-sm px-1">
        <span>
          {t("tocRule.split")}
          <span className="block text-[11px] text-secondary">{t("tocRule.split.note")}</span>
        </span>
        <Switch
          checked={settings.splitLongChapters}
          disabled={busy}
          onCheckedChange={onToggleSplit}
        />
      </label>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" disabled={busy} onClick={() => onEdit(NEW_TOC_RULE)}>
          <Icon name="add" size={14} />
          {t("tocRule.create")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onShowImport}>
          <Icon name="content_paste" size={14} />
          {t("common.import")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => report(onExport().then(copyText), t("tocRule.exported"))}
        >
          <Icon name="content_copy" size={14} />
          {t("common.export")}
        </Button>
      </div>
    </>
  );
}

/** Edits one chapter rule, testing it against its example. */
export function TocRuleEditor({
  rule,
  busy,
  onTest,
  onCancel,
  onSave,
}: {
  rule: TxtTocRule;
  busy: boolean;
  onTest: (pattern: string, sample: string) => Promise<string[]>;
  onCancel: () => void;
  onSave: (rule: TxtTocRule) => void;
}) {
  const [draft, setDraft] = useState(rule);
  const [tested, setTested] = useState<string[] | string | null>(null);
  const area =
    "w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50";
  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
      <label className="block space-y-1 text-xs text-secondary">
        {t("style.name")}
        <Input
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="block space-y-1 text-xs text-secondary">
        {t("tocRule.pattern")}
        <textarea
          rows={3}
          spellCheck={false}
          className={`${area} font-mono text-[13px]`}
          value={draft.pattern}
          onChange={(event) => {
            setDraft({ ...draft, pattern: event.target.value });
            setTested(null);
          }}
        />
      </label>
      <label className="block space-y-1 text-xs text-secondary">
        {t("tocRule.example")}
        <textarea
          rows={3}
          className={area}
          value={draft.example}
          onChange={(event) => {
            setDraft({ ...draft, example: event.target.value });
            setTested(null);
          }}
        />
      </label>
      {tested !== null && (
        <div className="text-xs rounded-lg bg-surface-container px-3 py-2 space-y-1">
          {typeof tested === "string" ? (
            <p className="text-error">{tested}</p>
          ) : tested.length ? (
            tested.map((title, index) => <p key={index}>✓ {title}</p>)
          ) : (
            <p className="text-secondary">{t("tocRule.noMatch")}</p>
          )}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <Button
          variant="outline"
          size="sm"
          disabled={!draft.pattern}
          onClick={() =>
            onTest(draft.pattern, draft.example).then(setTested, (error: unknown) =>
              setTested(String(error)),
            )
          }
        >
          {t("tocRule.test")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" disabled={busy || !draft.name.trim()} onClick={() => onSave(draft)}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Imports a rule export from Legado or GripRead: pasted, or with `loader`
 * from an address, a file, or the clipboard.
 */
export function TocRuleImport({
  busy,
  loader,
  onCancel,
  onImport,
}: {
  busy: boolean;
  loader?: RuleTextService;
  onCancel: () => void;
  onImport: (json: string) => void;
}) {
  const [json, setJson] = useState("");
  return (
    <div className="space-y-3">
      {loader && (
        <RuleTextLoader
          service={loader}
          historyKey="gripread.tocRuleImportHistory"
          onText={setJson}
        />
      )}
      <textarea
        rows={8}
        aria-label={t("tocRule.json")}
        spellCheck={false}
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        placeholder='[{"name":"示例","rule":"^第.+章.*$","enable":true}]'
        value={json}
        onChange={(event) => setJson(event.target.value)}
      />
      <div className="flex gap-2 justify-end">
        {!loader && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigator.clipboard.readText().then(setJson, () => undefined)}
          >
            {t("rules.paste")}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" disabled={busy || !json.trim()} onClick={() => onImport(json)}>
          {t("common.import")}
        </Button>
      </div>
    </div>
  );
}
