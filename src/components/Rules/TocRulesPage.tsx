import { useCallback, useEffect, useState } from "react";
import type { ReaderService } from "../../services/contracts";
import { copyText } from "../../services/system";
import type { TxtTocRule } from "../../types/generated";
import { FullPage } from "../Layout/FullPage";
import { NEW_TOC_RULE, TocRuleEditor, TocRuleImport } from "../Reader/dialogs/TocRuleDialog";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { NoticeLine, useNotice } from "../ui/notice";
import { Switch } from "../ui/switch";

/**
 * Legado's TXT目录规则 management outside a book: the shared rules that
 * automatic detection tries in order, with enable, edit and test, reorder,
 * delete, and exchange with Legado. Which rule a book uses is chosen in the
 * reader; books pick up changes the next time their directory is built.
 */
export function TocRulesPage({
  service,
  onClose,
}: {
  service: ReaderService;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<TxtTocRule[]>([]);
  const [message, setMessage] = useNotice();
  const [editing, setEditing] = useState<TxtTocRule | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => service.listTxtTocRules().then(setRules), [service]);
  useEffect(() => {
    void load().catch((error: unknown) => setMessage({ text: String(error), error: true }));
  }, [load]);
  /** Runs a change and reloads; `work` may return the message to show. */
  const change = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      const result = await work();
      await load();
      const text = typeof result === "string" && !done ? result : done;
      setMessage(text ? { text } : null);
      return true;
    } catch (error) {
      setMessage({ text: String(error), error: true });
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
      label="TXT目录规则"
      onClose={onClose}
      layer="z-[45]"
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label="新建规则"
            className="h-9 w-9 rounded-full text-secondary"
            onClick={() => setEditing(NEW_TOC_RULE)}
          >
            <Icon name="add" size={20} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setImporting(true)}>
            导入
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!rules.length}
            onClick={() =>
              void change(async () => {
                await copyText(await service.exportTxtTocRules());
                return "全部规则已复制到剪贴板，可粘贴到阅读（Legado）导入。";
              })
            }
          >
            导出
          </Button>
        </>
      }
    >
      <p className="px-1 text-[11px] text-secondary">
        开启的规则参与自动识别，排在前面的优先；每本书使用的规则在阅读界面的目录规则中选择。
      </p>
      <NoticeLine notice={message} />
      <ul
        aria-label="目录规则"
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
                {rule.builtin && <span className="ml-2 text-[10px] text-secondary">内置</span>}
              </span>
              <span className="block text-[11px] text-secondary truncate">
                {rule.example.split("\n")[0] || rule.pattern || "按字数分章"}
              </span>
            </button>
            <Switch
              size="sm"
              aria-label={`${rule.name} 参与自动识别`}
              checked={rule.enabled}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void change(() => service.saveTxtTocRule({ ...rule, enabled }))
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`上移 ${rule.name}`}
              className="h-7 w-7 text-secondary"
              disabled={busy || index === 0}
              onClick={() => move(index, -1)}
            >
              <Icon name="arrow_upward" size={14} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`下移 ${rule.name}`}
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
                aria-label={`删除 ${rule.name}`}
                className="h-7 w-7 text-secondary"
                disabled={busy}
                onClick={() => void change(() => service.deleteTxtTocRule(rule.id), "规则已删除。")}
              >
                <Icon name="delete" size={14} />
              </Button>
            )}
          </li>
        ))}
      </ul>
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
                {importing ? "导入规则" : editing?.id ? "编辑规则" : "新建规则"}
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
                    rule.id ? "规则已保存。" : "规则已添加。",
                  ).then((saved) => saved && setEditing(null))
                }
              />
            )}
            {importing && (
              <TocRuleImport
                busy={busy}
                onCancel={() => setImporting(false)}
                onImport={(json) =>
                  void change(async () => {
                    const added = await service.importTxtTocRules(json);
                    return added.length ? `已导入 ${added.length} 条规则。` : "没有新的规则。";
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
