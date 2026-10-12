import { useEffect, useState } from "react";
import type { SourceService } from "../../services/contracts";
import { copyText } from "../../services/system";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Icon } from "../ui/Icon";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { SOURCE_TABS, fieldValue, withField, type SourceJson } from "./source-fields";

const JSON_TAB = "json";

function parseSource(text: string): SourceJson {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("书源 JSON 必须是一个对象");
  return value as SourceJson;
}

/**
 * Legado's source editor: the fields grouped as 基本、搜索、发现、详情、目录、
 * 正文, and the whole JSON for anything the form does not show. Unknown
 * fields are kept.
 */
export function SourceEditPage({
  service,
  url,
  onSaved,
  onDebug,
  onLogin,
  onClose,
}: {
  service: SourceService;
  /** The source to edit, or `null` for a new one. */
  url: string | null;
  onSaved: () => void;
  onDebug: (url: string) => void;
  onLogin: (url: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<SourceJson | null>(url ? null : {});
  const [savedText, setSavedText] = useState(url ? "" : "{}");
  const [savedUrl, setSavedUrl] = useState<string | null>(url);
  const [tab, setTab] = useState(SOURCE_TABS[0].id);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [variable, setVariable] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    void service.getSource(url).then(
      (detail) => {
        const parsed = parseSource(detail.json);
        setSource(parsed);
        setSavedText(JSON.stringify(parsed));
      },
      (failure: unknown) => toast({ text: String(failure), error: true }),
    );
  }, [service, url]);

  if (!source) return null;
  const dirty = JSON.stringify(source) !== savedText;

  const switchTab = (next: string) => {
    if (tab === JSON_TAB && next !== JSON_TAB) {
      try {
        setSource(parseSource(jsonText));
        setJsonError(null);
      } catch (failure) {
        setJsonError(String(failure));
        return;
      }
    }
    if (next === JSON_TAB) setJsonText(JSON.stringify(source, null, 2));
    setTab(next);
  };

  const current = (): SourceJson | null => {
    if (tab !== JSON_TAB) return source;
    try {
      const parsed = parseSource(jsonText);
      setSource(parsed);
      setJsonError(null);
      return parsed;
    } catch (failure) {
      setJsonError(String(failure));
      return null;
    }
  };

  const save = async (): Promise<string | null> => {
    const value = current();
    if (!value) return null;
    try {
      const summary = await service.saveSource(JSON.stringify(value), savedUrl);
      setSavedText(JSON.stringify(value));
      setSavedUrl(summary.url);
      onSaved();
      toast("书源已保存");
      return summary.url;
    } catch (failure) {
      toast({ text: String(failure), error: true });
      return null;
    }
  };

  const close = () => (dirty ? setConfirmClose(true) : onClose());
  const activeTab = SOURCE_TABS.find((item) => item.id === tab);

  const actions = (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="保存书源"
        className="h-9 w-9 rounded-full text-primary"
        onClick={() => void save()}
      >
        <Icon name="save" size={19} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="更多"
          className="h-9 w-9 rounded-full inline-flex items-center justify-center text-secondary hover:bg-surface-container"
        >
          <Icon name="more_vert" size={19} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            onClick={() =>
              void save().then((saved) => {
                if (saved) onDebug(saved);
              })
            }
          >
            <Icon name="bug_report" size={15} />
            保存并调试
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void save().then((saved) => {
                if (saved) onLogin(saved);
              })
            }
          >
            <Icon name="login" size={15} />
            登录
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              const value = current();
              if (value)
                void copyText(JSON.stringify(value, null, 2)).then(() => toast("书源已复制"));
            }}
          >
            <Icon name="content_copy" size={15} />
            复制源
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void navigator.clipboard
                .readText()
                .then((text) => {
                  const parsed = parseSource(text);
                  setSource(parsed);
                  if (tab === JSON_TAB) setJsonText(JSON.stringify(parsed, null, 2));
                  toast("已粘贴，保存后生效");
                })
                .catch(() =>
                  toast({ text: "无法读取剪贴板里的书源，可以在 JSON 页直接粘贴", error: true }),
                )
            }
          >
            <Icon name="content_paste" size={15} />
            粘贴源
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!savedUrl}
            onClick={() =>
              savedUrl &&
              void service.getVariable(savedUrl).then((value) => setVariable(value ?? ""))
            }
          >
            <Icon name="code" size={15} />
            设置源变量
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!savedUrl}
            onClick={() =>
              savedUrl &&
              void service.clearCookies(savedUrl).then(() => toast("已清除这个网站的 Cookie"))
            }
          >
            <Icon name="delete" size={15} />
            清除 Cookie
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <FullPage
      label={url ? "编辑书源" : "新建书源"}
      onClose={close}
      actions={actions}
      layer="z-[45]"
    >
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1" role="tablist">
        {[...SOURCE_TABS.map((item) => [item.id, item.label]), [JSON_TAB, "JSON"]].map(
          ([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => switchTab(id)}
              className={`shrink-0 h-8 px-3.5 rounded-full text-xs ${
                tab === id
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-low text-secondary"
              }`}
            >
              {label}
            </button>
          ),
        )}
      </div>

      {activeTab?.switches && (
        <div className="rounded-xl bg-surface-container-low divide-y divide-surface-variant/30">
          {activeTab.switches.map((item) => (
            <label key={item.key} className="flex items-center justify-between px-3 py-2.5 text-sm">
              {item.label}
              <Switch
                aria-label={item.label}
                checked={
                  source[item.key] === undefined ? item.fallback : source[item.key] !== false
                }
                onCheckedChange={(on) => setSource({ ...source, [item.key]: on })}
              />
            </label>
          ))}
        </div>
      )}

      {activeTab && (
        <div className="space-y-3">
          {activeTab.fields.map((field) => {
            const value = fieldValue(source, field);
            const id = `${field.section ?? "source"}-${field.key}`;
            return (
              <label key={id} className="block space-y-1">
                <span className="text-xs text-secondary">{field.label}</span>
                <textarea
                  aria-label={field.label}
                  placeholder={field.hint}
                  value={value}
                  rows={field.code ? Math.min(8, Math.max(1, value.split("\n").length)) : 1}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => setSource(withField(source, field, event.target.value))}
                  className={`w-full rounded-lg border border-input bg-transparent px-3 py-2 outline-none resize-y focus:border-primary ${
                    field.code ? "font-mono text-xs leading-relaxed" : "text-sm"
                  }`}
                />
              </label>
            );
          })}
        </div>
      )}

      {tab === JSON_TAB && (
        <div className="space-y-2">
          <textarea
            aria-label="书源 JSON"
            value={jsonText}
            onChange={(event) => setJsonText(event.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            rows={24}
            className="w-full rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs leading-relaxed outline-none resize-y"
          />
          {jsonError && (
            <p role="alert" className="text-xs text-error break-words">
              {jsonError}
            </p>
          )}
        </div>
      )}

      {confirmClose && (
        <Dialog open onOpenChange={(open) => !open && setConfirmClose(false)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">放弃修改？</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">书源有未保存的修改。</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                放弃
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void save().then((saved) => {
                    if (saved) onClose();
                  })
                }
              >
                保存
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {variable !== null && savedUrl && (
        <Dialog open onOpenChange={(open) => !open && setVariable(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">源变量</DialogTitle>
            </DialogHeader>
            {typeof source.variableComment === "string" && source.variableComment && (
              <p className="text-xs text-secondary whitespace-pre-wrap">{source.variableComment}</p>
            )}
            <textarea
              aria-label="源变量"
              rows={5}
              value={variable}
              onChange={(event) => setVariable(event.target.value)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono outline-none resize-y"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setVariable(null)}>
                取消
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void service.setVariable(savedUrl, variable || null).then(() => {
                    setVariable(null);
                    toast("源变量已保存");
                  })
                }
              >
                保存
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </FullPage>
  );
}
