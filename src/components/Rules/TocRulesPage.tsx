import { useCallback, useEffect, useState } from "react";
import type { ReaderService } from "../../services/contracts";
import { copyText } from "../../services/system";
import type { TxtTocRule } from "../../types/generated";
import { FullPage } from "../Layout/FullPage";
import { NEW_TOC_RULE, TocRuleEditor, TocRuleImport } from "../Reader/dialogs/TocRuleDialog";
import {
  UntitledTitleDialog,
  untitledLabel,
  type UntitledStyle,
} from "../Reader/dialogs/UntitledTitleDialog";
import { useRuntime, useSettings } from "../../application/runtime";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { reportError, toast } from "../ui/toast";
import { Switch } from "../ui/switch";
import { t } from "../../i18n";

/**
 * 目录规则 management outside a book: the default titles of books no rule
 * splits, and the shared rules that automatic detection tries in order, with
 * enable, edit and test, reorder, delete, and exchange with Legado (import
 * and export in More). Which rule a book uses is chosen in the reader; books
 * pick up changes the next time their directory is built.
 */
export function TocRulesPage({
  service,
  onClose,
}: {
  service: ReaderService;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<TxtTocRule[]>([]);
  const [editing, setEditing] = useState<TxtTocRule | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [defaults, setDefaults] = useState(false);
  const runtime = useRuntime();
  const { state: settings, store: settingsStore } = useSettings();
  const fallback = {
    title: settings.value?.tocUntitledTitle,
    chunkKb: settings.value?.tocChunkKb,
  };
  /** Saves the default, then has every book's contents read again. */
  const saveDefaults = async (style: UntitledStyle) => {
    settingsStore.set({ tocUntitledTitle: style.title, tocChunkKb: style.chunkKb });
    try {
      await settingsStore.flush();
    } catch (error) {
      reportError(error);
      return;
    }
    const books = runtime.library.getSnapshot().books;
    books.forEach((entry) => runtime.shelf.invalidateChapterCache(entry.book.id));
    void runtime.shelf.load(books);
  };
  const load = useCallback(() => service.listTxtTocRules().then(setRules), [service]);
  useEffect(() => {
    void load().catch(reportError);
  }, [load]);
  /** Runs a change and reloads; `work` may return the message to show. */
  const change = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      const result = await work();
      await load();
      const text = typeof result === "string" && !done ? result : done;
      if (text) toast(text);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const move = (index: number, step: -1 | 1) => {
    const ids = rules.map((rule) => rule.id);
    [ids[index], ids[index + step]] = [ids[index + step], ids[index]];
    void change(() => service.orderTxtTocRules(ids));
  };
  return (
    <FullPage
      label={t("settings.toc")}
      onClose={onClose}
      layer="z-[45]"
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("tocRule.new")}
            className="h-9 w-9 rounded-full text-secondary"
            onClick={() => setEditing(NEW_TOC_RULE)}
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
              <DropdownMenuItem onClick={() => setImporting(true)}>
                <Icon name="download" size={15} />
                {t("common.import")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!rules.length}
                onClick={() =>
                  void change(async () => {
                    await copyText(await service.exportTxtTocRules());
                    return t("tocRule.exported");
                  })
                }
              >
                <Icon name="content_copy" size={15} />
                {t("common.export")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <button
        type="button"
        className="w-full flex items-center gap-3 rounded-xl bg-surface-container-low px-4 py-3 text-left"
        onClick={() => setDefaults(true)}
      >
        <Icon name="title" size={18} className="text-secondary shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-sm">{t("contents.untitledDefault")}</span>
          <span className="block text-[11px] text-secondary truncate">
            {untitledLabel(fallback)}
          </span>
        </span>
        <Icon name="chevron_right" size={16} className="text-secondary shrink-0" />
      </button>
      <p className="px-1 text-[11px] text-secondary">{t("tocRule.pageNote")}</p>
      <ul
        aria-label={t("reader.tool.tocRules")}
        className="rounded-xl bg-surface-container-low divide-y divide-surface-variant/30"
      >
        {rules.map((rule, index) => (
          <li key={rule.id} className="flex items-center gap-1.5 pl-4 pr-1 py-2">
            <button
              type="button"
              className="flex-1 min-w-0 text-left"
              onClick={() => setEditing(rule)}
            >
              <span className="block text-sm truncate">
                {rule.name}
                {rule.builtin && (
                  <span className="ml-2 text-[10px] text-secondary">{t("tocRule.builtin")}</span>
                )}
                {rule.loose && (
                  <span
                    className="ml-1.5 text-[10px] text-secondary"
                    title={t("tocRule.looseNote")}
                  >
                    {t("tocRule.loose")}
                  </span>
                )}
              </span>
              <span className="block text-[11px] text-secondary truncate">
                {rule.example.split("\n")[0] || rule.pattern || t("tocRule.byLength")}
              </span>
            </button>
            <Switch
              size="sm"
              aria-label={t("tocRule.enabled", { name: rule.name })}
              checked={rule.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void change(() => service.saveTxtTocRule({ ...rule, enabled }))
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("tools.up", { name: rule.name })}
              className="h-7 w-7 text-secondary"
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            >
              <Icon name="arrow_upward" size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("tools.down", { name: rule.name })}
              className="h-7 w-7 text-secondary"
              disabled={busy || index === rules.length - 1}
              onClick={() => move(index, 1)}
            >
              <Icon name="arrow_downward" size={14} />
            </Button>
            {!rule.builtin && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("shelf.bin.deleteBook", { title: rule.name })}
                className="h-7 w-7 text-secondary"
                disabled={busy}
                onClick={() =>
                  void change(() => service.deleteTxtTocRule(rule.id), t("tocRule.deleted"))
                }
              >
                <Icon name="delete" size={14} />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {defaults && (
        <UntitledTitleDialog
          style={fallback}
          busy={false}
          onSave={(style) => {
            setDefaults(false);
            void saveDefaults(style);
          }}
          onClose={() => setDefaults(false)}
        />
      )}
      {(editing || importing) && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (open) return;
            setEditing(null);
            setImporting(false);
          }}
        >
          <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-lg max-h-[80dvh] flex flex-col gap-2.5 p-4">
            <DialogHeader>
              <DialogTitle>
                {importing
                  ? t("tocRule.import")
                  : editing?.id
                    ? t("tocRule.edit")
                    : t("tocRule.new")}
              </DialogTitle>
            </DialogHeader>
            {editing && (
              <TocRuleEditor
                rule={editing}
                busy={busy}
                onTest={(pattern, sample) => service.testTxtTocRule(pattern, sample)}
                onCancel={() => setEditing(null)}
                onSave={(rule) =>
                  void change(
                    () => service.saveTxtTocRule(rule),
                    rule.id ? t("tocRule.saved") : t("tocRule.added"),
                  ).then((saved) => saved && setEditing(null))
                }
              />
            )}
            {importing && (
              <TocRuleImport
                busy={busy}
                loader={service}
                onCancel={() => setImporting(false)}
                onImport={(json) =>
                  void change(async () => {
                    const added = await service.importTxtTocRules(json);
                    return added.length
                      ? t("tocRule.imported", { count: added.length })
                      : t("tocRule.noneNew");
                  }).then((saved) => saved && setImporting(false))
                }
              />
            )}
          </DialogContent>
        </Dialog>
      )}
    </FullPage>
  );
}
