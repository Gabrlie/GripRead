import { useEffect, useState } from "react";
import type { ReaderService } from "../../services/contracts";
import { copyText } from "../../services/system";
import type { ReplaceRule } from "../../types/generated";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { NoticeLine, useNotice } from "../ui/notice";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { usePageLayer } from "../Layout/use-page-layer";

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
  const [message, setMessage] = useNotice();
  const [editing, setEditing] = useState<ReplaceRule | null>(null);
  const [importing, setImporting] = useState(false);
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
          if (done) setMessage(done);
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
      aria-label="替换净化"
      data-open=""
      className="fixed inset-0 z-[45] bg-surface text-on-surface flex flex-col pt-safe pb-safe"
    >
      <header className="shrink-0 h-14 px-2 flex items-center gap-1 border-b border-surface-variant/30 max-w-3xl mx-auto w-full">
        <Button
          variant="ghost"
          size="icon"
          aria-label="返回"
          className="h-9 w-9 rounded-full text-secondary"
          onClick={onClose}
        >
          <Icon name="arrow_back" size={20} />
        </Button>
        <h1 className="flex-1 font-title-editorial text-base font-semibold">替换净化</h1>
        <Button
          variant="ghost"
          size="icon"
          aria-label="添加规则"
          className="h-9 w-9 rounded-full text-secondary"
          onClick={() => setEditing(EMPTY_REPLACE_RULE)}
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
            void service
              .exportReplaceRules()
              .then(copyText)
              .then(
                () => setMessage("全部规则已复制到剪贴板，可粘贴到阅读（Legado）导入。"),
                (failure: unknown) => setError(String(failure)),
              )
          }
        >
          导出
        </Button>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto w-full p-3 space-y-2">
          {book && (
            <label className="flex items-center justify-between gap-3 rounded-xl bg-surface-container-low px-4 py-3 text-sm">
              <span>
                本书使用替换规则
                <span className="block text-[11px] text-secondary">
                  规则作用于每一行正文，修改后重新生成本书文本，阅读位置和书签会随之调整。
                </span>
              </span>
              <Switch
                aria-label="本书使用替换规则"
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
          <NoticeLine notice={message} />
          {rules.length === 0 && (
            <p className="text-sm text-secondary px-1 py-6 text-center">
              还没有替换规则。可以添加，或导入阅读（Legado）导出的规则。
            </p>
          )}
          {rules.map((rule, index) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 rounded-xl bg-surface-container-low pl-3 pr-1 py-2"
            >
              <Switch
                aria-label={`启用 ${rule.name}`}
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
                  {rule.pattern} → {rule.replacement || "（删除）"}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`上移 ${rule.name}`}
                className="h-8 w-8 text-secondary"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <Icon name="arrow_upward" size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`下移 ${rule.name}`}
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
        <ImportDialog
          onImport={(json) =>
            service.importReplaceRules(json).then((added) => {
              setImporting(false);
              change(
                async () => undefined,
                added.length ? `已导入 ${added.length} 条规则。` : "没有新的规则。",
              );
            })
          }
          onClose={() => setImporting(false)}
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
            {initial.id ? "编辑替换规则" : "添加替换规则"}
          </DialogTitle>
        </DialogHeader>
        {field("名称", "name")}
        {field("分组", "group", "可选")}
        {field("替换内容", "pattern", rule.isRegex ? "正则表达式" : "要替换的文字")}
        {field(
          "替换为",
          "replacement",
          rule.isRegex ? "可用 $1 引用分组，留空即删除" : "留空即删除",
        )}
        <label className="flex items-center justify-between text-xs">
          使用正则表达式
          <Switch
            aria-label="使用正则表达式"
            checked={rule.isRegex}
            onCheckedChange={(isRegex) => setRule({ ...rule, isRegex })}
          />
        </label>
        {field("作用范围", "scope", "书名，多个用分号隔开；留空作用于所有书")}
        <div className="space-y-1.5 rounded-xl bg-surface-container-low p-3">
          <textarea
            aria-label="测试文字"
            placeholder="输入一段文字测试规则"
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
            测试
          </Button>
          {result !== null && (
            <p className="text-sm whitespace-pre-wrap break-words" aria-label="测试结果">
              {result || "（结果为空）"}
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
              删除
            </Button>
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!rule.name.trim() || !rule.pattern}
              onClick={() => void onSave(rule).catch(fail)}
            >
              保存
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({
  onImport,
  onClose,
}: {
  onImport: (json: string) => Promise<void>;
  onClose: () => void;
}) {
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">导入替换规则</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-secondary">
          粘贴从阅读（Legado）或本应用导出的规则 JSON。只替换标题的规则不会导入。
        </p>
        <textarea
          aria-label="规则 JSON"
          rows={8}
          value={json}
          onChange={(event) => setJson(event.target.value)}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono outline-none resize-y"
        />
        {error && (
          <p role="alert" className="text-xs text-error break-words">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            disabled={!json.trim()}
            onClick={() =>
              void onImport(json).catch((failure: unknown) => setError(String(failure)))
            }
          >
            导入
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
