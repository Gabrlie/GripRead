import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import { copyText } from "../../services/system";
import type { BookSourceSummary, SourceCheckEvent } from "../../types/generated";
import {
  BASIC_FILTERS,
  SOURCE_SORTS,
  filterSources,
  formatRespondTime,
  sameFilter,
  sortSources,
  sourceError,
  sourceGroups,
  splitGroups,
  type SourceFilter,
  type SourceSort,
} from "../../application/sources";
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
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { SourceImportDialog, type ImportMethod } from "./SourceImportDialog";
import { SourceEditPage } from "./SourceEditPage";
import { SourceDebugPage } from "./SourceDebugPage";
import { SourceLoginDialog } from "./SourceLoginDialog";

interface CheckProgress {
  operationId: string;
  checked: number;
  total: number;
  current: string;
  done: boolean;
}

const SORT_KEY = "gripread.sourceSort";

function newOperationId(): string {
  return `source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Legado's 书源管理: search, filter, and sort the sources; switch them on and
 * off; edit, debug, and log in to one; and import, export, group, order,
 * check, or delete several at once.
 */
export function SourceManagePage({
  service,
  onClose,
}: {
  service: SourceService;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<BookSourceSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SourceFilter>({ kind: "all" });
  // 智能排序 by default; a chosen order is remembered on this device.
  const [sort, setSortState] = useState<SourceSort>(() => {
    try {
      const kept = localStorage.getItem(SORT_KEY);
      return SOURCE_SORTS.some(([value]) => value === kept) ? (kept as SourceSort) : "weight";
    } catch {
      return "weight";
    }
  });
  const setSort = (value: SourceSort) => {
    setSortState(value);
    try {
      localStorage.setItem(SORT_KEY, value);
    } catch {
      // Remembering the order is a convenience.
    }
  };
  const [reverse, setReverse] = useState(false);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [importing, setImporting] = useState<ImportMethod | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [debugging, setDebugging] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState<string | null>(null);
  const [grouping, setGrouping] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [checking, setChecking] = useState<CheckProgress | null>(null);
  const checkId = useRef<string | null>(null);
  const [checkKeyword, setCheckKeyword] = useState<string[] | null>(null);

  const load = () =>
    service.listSources().then(
      (list) => {
        setSources(list);
        setLoaded(true);
      },
      (failure: unknown) => toast({ text: String(failure), error: true }),
    );
  useEffect(() => {
    void load();
  }, [service]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void service
      .onCheck((event: SourceCheckEvent) => {
        if (checkId.current !== event.operationId) return;
        if (event.url === "" && event.finished) {
          checkId.current = null;
          toast(`${event.message}：${event.checked}/${event.total}`);
          void load();
          setChecking((current) => current && { ...current, checked: event.checked, done: true });
          return;
        }
        if (event.finished) void load();
        setChecking(
          (current) =>
            current && {
              ...current,
              checked: event.finished ? event.checked : current.checked,
              current: `${event.name}：${event.message}`,
            },
        );
      })
      .then((stop) => {
        if (active) unsubscribe = stop;
        else stop();
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [service]);

  const groups = useMemo(() => sourceGroups(sources), [sources]);
  const shown = useMemo(
    () => sortSources(filterSources(sources, query, filter), sort, reverse),
    [sources, query, filter, sort, reverse],
  );
  const enabledCount = sources.filter((source) => source.enabled).length;

  const run = (action: () => Promise<unknown>, done?: string) =>
    void action()
      .then(load)
      .then(
        () => done && toast(done),
        (failure: unknown) => toast({ text: String(failure), error: true }),
      );

  const selectedUrls = selected ? shown.filter((s) => selected.has(s.url)).map((s) => s.url) : [];
  const toggleSelected = (url: string) =>
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const startCheck = (urls: string[], keyword: string, disableFailed: boolean) => {
    const operationId = newOperationId();
    checkId.current = operationId;
    setChecking({ operationId, checked: 0, total: urls.length, current: "准备校验", done: false });
    void service
      .check({ operationId, urls, keyword, disableFailed })
      .catch((failure: unknown) => toast({ text: String(failure), error: true }));
  };

  const exportTo = (urls: string[], target: "file" | "clipboard") =>
    target === "file"
      ? void service.exportSourcesFile(urls).then(
          (saved) => saved && toast(`已导出 ${urls.length || sources.length} 个书源`),
          (failure: unknown) => toast({ text: String(failure), error: true }),
        )
      : void service
          .exportSources(urls)
          .then(copyText)
          .then(
            () => toast("书源已复制到剪贴板"),
            (failure: unknown) => toast({ text: String(failure), error: true }),
          );

  const filterChip = (value: SourceFilter, label: string) => {
    const active = sameFilter(filter, value);
    return (
      <button
        key={value.kind === "group" ? `group:${value.name}` : value.kind}
        type="button"
        aria-pressed={active}
        onClick={() => setFilter(value)}
        className={`shrink-0 h-7 px-3 rounded-full text-xs border transition-colors ${
          active
            ? "bg-primary text-on-primary border-primary"
            : "bg-surface-container-low text-secondary border-transparent"
        }`}
      >
        {label}
      </button>
    );
  };

  const actions = selected ? (
    <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
      完成
    </Button>
  ) : (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="新建书源"
        className="h-9 w-9 rounded-full text-secondary"
        onClick={() => setEditing("new")}
      >
        <Icon name="add" size={20} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="排序"
          className="h-9 w-9 rounded-full inline-flex items-center justify-center text-secondary hover:bg-surface-container"
        >
          <Icon name="swap_vert" size={19} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => setReverse((value) => !value)}>
            <Icon name={reverse ? "check_box" : "check_box_outline"} size={15} />
            反序
          </DropdownMenuItem>
          {SOURCE_SORTS.map(([value, label]) => (
            <DropdownMenuItem key={value} onClick={() => setSort(value)}>
              <Icon name="check" size={15} className={sort === value ? "" : "opacity-0"} />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="更多"
          className="h-9 w-9 rounded-full inline-flex items-center justify-center text-secondary hover:bg-surface-container"
        >
          <Icon name="more_vert" size={19} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => setImporting("network")}>
            <Icon name="public" size={15} />
            网络导入
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setImporting("file")}>
            <Icon name="description" size={15} />
            本地导入
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setImporting("paste")}>
            <Icon name="content_paste" size={15} />
            粘贴导入
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!sources.length} onClick={() => setSelected(new Set())}>
            <Icon name="checklist" size={15} />
            多选
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!sources.length}
            onClick={() => setCheckKeyword(shown.map((source) => source.url))}
          >
            <Icon name="check_circle" size={15} />
            校验显示的书源
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!sources.length} onClick={() => exportTo([], "file")}>
            <Icon name="upload" size={15} />
            导出全部
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <FullPage label="书源管理" onClose={onClose} actions={actions}>
      <div className="space-y-2">
        <label className="flex items-center gap-2 rounded-xl bg-surface-container-low px-3 h-10">
          <Icon name="search" size={16} className="text-secondary" />
          <input
            aria-label="搜索书源"
            placeholder="搜索名称、网址、分组或注释"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="flex-1 min-w-0 bg-transparent text-sm outline-none"
          />
          {query && (
            <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>
              <Icon name="close" size={15} className="text-secondary" />
            </button>
          )}
        </label>
        <div
          className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1"
          role="group"
          aria-label="筛选"
        >
          {BASIC_FILTERS.map(([value, label]) => filterChip(value, label))}
          {groups.map((name) => filterChip({ kind: "group", name }, name))}
        </div>
        <p className="px-1 text-[11px] text-secondary">
          共 {sources.length} 个书源，{enabledCount} 个启用
          {shown.length !== sources.length && `，显示 ${shown.length} 个`}
        </p>
      </div>

      {loaded && sources.length === 0 && (
        <div className="py-10 text-center space-y-3">
          <p className="text-sm text-secondary">还没有书源。可以从网址、文件或剪贴板导入书源。</p>
          <div className="flex justify-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setImporting("network")}>
              网络导入
            </Button>
            <Button size="sm" variant="outline" onClick={() => setImporting("paste")}>
              粘贴导入
            </Button>
          </div>
        </div>
      )}

      <ul className="space-y-1.5" aria-label="书源列表">
        {shown.map((source) => {
          const error = sourceError(source);
          const isSelected = selected?.has(source.url) ?? false;
          return (
            <li
              key={source.url}
              className={`flex items-center gap-2 rounded-xl pl-3 pr-1 py-2 ${
                isSelected ? "bg-primary/10" : "bg-surface-container-low"
              }`}
            >
              {selected && (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isSelected}
                  aria-label={`选择 ${source.name}`}
                  onClick={() => toggleSelected(source.url)}
                  className="text-primary"
                >
                  <Icon name={isSelected ? "check_box" : "check_box_outline"} size={18} />
                </button>
              )}
              <button
                type="button"
                className="flex-1 min-w-0 text-left"
                onClick={() => (selected ? toggleSelected(source.url) : setEditing(source.url))}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-sm truncate ${source.enabled ? "" : "text-secondary"}`}>
                    {source.name}
                  </span>
                  {source.hasExplore && (
                    <Icon
                      name="explore"
                      size={12}
                      className={source.enabledExplore ? "text-primary" : "text-secondary/50"}
                      aria-label={source.enabledExplore ? "有发现" : "发现已禁用"}
                    />
                  )}
                  {source.hasLogin && (
                    <Icon name="login" size={12} className="text-secondary" aria-label="需登录" />
                  )}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-secondary min-w-0">
                  {splitGroups(source.group).map((name) => (
                    <span
                      key={name}
                      className="shrink-0 rounded px-1 bg-surface-container text-[10px] leading-4"
                    >
                      {name}
                    </span>
                  ))}
                  <span className="truncate">{source.url}</span>
                </span>
                {error ? (
                  <span className="block text-[11px] text-error truncate">{error}</span>
                ) : (
                  source.respondTime < 180000 && (
                    <span className="block text-[10px] text-secondary/70">
                      响应 {formatRespondTime(source.respondTime)}
                    </span>
                  )
                )}
              </button>
              {!selected && (
                <>
                  <Switch
                    aria-label={`启用 ${source.name}`}
                    checked={source.enabled}
                    onCheckedChange={(on) =>
                      run(() => service.setSwitch([source.url], "enabled", on))
                    }
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`${source.name} 的更多操作`}
                      className="h-8 w-8 rounded-full inline-flex items-center justify-center text-secondary"
                    >
                      <Icon name="more_vert" size={16} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onClick={() => setEditing(source.url)}>
                        <Icon name="edit" size={15} />
                        编辑
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => run(() => service.moveSources([source.url], true))}
                      >
                        <Icon name="vertical_align_top" size={15} />
                        置顶
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => run(() => service.moveSources([source.url], false))}
                      >
                        <Icon name="vertical_align_bottom" size={15} />
                        置底
                      </DropdownMenuItem>
                      {source.hasLogin && (
                        <DropdownMenuItem onClick={() => setLoggingIn(source.url)}>
                          <Icon name="login" size={15} />
                          登录
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => setDebugging(source.url)}>
                        <Icon name="bug_report" size={15} />
                        调试
                      </DropdownMenuItem>
                      {source.hasExplore && (
                        <DropdownMenuItem
                          onClick={() =>
                            run(() =>
                              service.setSwitch([source.url], "explore", !source.enabledExplore),
                            )
                          }
                        >
                          <Icon name="explore" size={15} />
                          {source.enabledExplore ? "禁用发现" : "启用发现"}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => setCheckKeyword([source.url])}>
                        <Icon name="check_circle" size={15} />
                        校验
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDeleting([source.url])}>
                        <Icon name="delete" size={15} className="text-error" />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </li>
          );
        })}
      </ul>

      {selected && (
        <div className="sticky bottom-0 -mx-3 px-3 pt-2 pb-2 bg-surface border-t border-surface-variant/30 space-y-2">
          <div className="flex items-center justify-between text-xs text-secondary">
            <span>
              已选 {selectedUrls.length} / {shown.length}
            </span>
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set(shown.map((s) => s.url)))}
              >
                全选
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSelected(new Set(shown.filter((s) => !selected.has(s.url)).map((s) => s.url)))
                }
              >
                反选
              </Button>
            </span>
          </div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar" aria-label="批量操作">
            {(
              [
                ["启用", () => run(() => service.setSwitch(selectedUrls, "enabled", true))],
                ["禁用", () => run(() => service.setSwitch(selectedUrls, "enabled", false))],
                ["分组", () => setGrouping(selectedUrls)],
                ["启用发现", () => run(() => service.setSwitch(selectedUrls, "explore", true))],
                ["禁用发现", () => run(() => service.setSwitch(selectedUrls, "explore", false))],
                ["置顶", () => run(() => service.moveSources(selectedUrls, true))],
                ["置底", () => run(() => service.moveSources(selectedUrls, false))],
                ["导出", () => exportTo(selectedUrls, "file")],
                ["复制", () => exportTo(selectedUrls, "clipboard")],
                ["校验", () => setCheckKeyword(selectedUrls)],
                ["删除", () => setDeleting(selectedUrls)],
              ] as [string, () => void][]
            ).map(([label, action]) => (
              <Button
                key={label}
                size="sm"
                variant="outline"
                className={`shrink-0 ${label === "删除" ? "text-error" : ""}`}
                disabled={!selectedUrls.length}
                onClick={action}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {checking && (
        <div
          role="status"
          className="fixed left-3 right-3 bottom-[calc(1rem+var(--safe-bottom))] z-[44] max-w-3xl mx-auto rounded-2xl bg-surface-container-high shadow-lg px-4 py-3 flex items-center gap-3"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm">
              {checking.done ? "校验完成" : "正在校验"} {checking.checked}/{checking.total}
            </p>
            {!checking.done && (
              <p className="text-[11px] text-secondary truncate">{checking.current}</p>
            )}
          </div>
          {checking.done ? (
            <Button size="sm" variant="ghost" onClick={() => setChecking(null)}>
              关闭
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void service.cancel(checking.operationId)}
            >
              停止
            </Button>
          )}
        </div>
      )}

      {importing && (
        <SourceImportDialog
          service={service}
          method={importing}
          onDone={(count) => {
            setImporting(null);
            void load();
            if (count) toast(`已导入 ${count} 个书源`);
          }}
          onClose={() => setImporting(null)}
        />
      )}
      {editing && (
        <SourceEditPage
          service={service}
          url={editing === "new" ? null : editing}
          onDebug={(url) => setDebugging(url)}
          onLogin={(url) => setLoggingIn(url)}
          onSaved={() => void load()}
          onClose={() => setEditing(null)}
        />
      )}
      {debugging && (
        <SourceDebugPage service={service} url={debugging} onClose={() => setDebugging(null)} />
      )}
      {loggingIn && (
        <SourceLoginDialog service={service} url={loggingIn} onClose={() => setLoggingIn(null)} />
      )}
      {grouping && (
        <GroupDialog
          groups={groups}
          onApply={(group, add) => {
            const urls = grouping;
            setGrouping(null);
            run(() => service.changeGroup(urls, group, add), add ? "已加入分组" : "已移出分组");
          }}
          onClose={() => setGrouping(null)}
        />
      )}
      {checkKeyword && (
        <CheckDialog
          count={checkKeyword.length}
          onStart={(keyword, disableFailed) => {
            const urls = checkKeyword;
            setCheckKeyword(null);
            startCheck(urls, keyword, disableFailed);
          }}
          onClose={() => setCheckKeyword(null)}
        />
      )}
      {deleting && (
        <Dialog open onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
            <DialogHeader>
              <DialogTitle className="font-title-editorial text-base">删除书源</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">
              确定删除 {deleting.length} 个书源吗？已加入书架的网络书籍会失去来源。
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button
                size="sm"
                className="bg-error text-on-error"
                onClick={() => {
                  const urls = deleting;
                  setDeleting(null);
                  setSelected(null);
                  run(() => service.deleteSources(urls), `已删除 ${urls.length} 个书源`);
                }}
              >
                删除
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </FullPage>
  );
}

function GroupDialog({
  groups,
  onApply,
  onClose,
}: {
  groups: string[];
  onApply: (group: string, add: boolean) => void;
  onClose: () => void;
}) {
  const [group, setGroup] = useState("");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">分组</DialogTitle>
        </DialogHeader>
        <Input
          aria-label="分组名称"
          placeholder="分组名称，多个用逗号隔开"
          value={group}
          onChange={(event) => setGroup(event.target.value)}
        />
        {groups.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {groups.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setGroup(name)}
                className="h-7 px-2.5 rounded-full text-xs bg-surface-container-low text-secondary"
              >
                {name}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!group.trim()}
            onClick={() => onApply(group, false)}
          >
            移出分组
          </Button>
          <Button size="sm" disabled={!group.trim()} onClick={() => onApply(group, true)}>
            加入分组
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CheckDialog({
  count,
  onStart,
  onClose,
}: {
  count: number;
  onStart: (keyword: string, disableFailed: boolean) => void;
  onClose: () => void;
}) {
  const [keyword, setKeyword] = useState("");
  const [disableFailed, setDisableFailed] = useState(true);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">校验 {count} 个书源</DialogTitle>
        </DialogHeader>
        <Input
          aria-label="校验关键字"
          placeholder="搜索关键字（可留空）"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>禁用失效的书源</span>
          <Switch
            aria-label="禁用失效的书源"
            checked={disableFailed}
            onCheckedChange={setDisableFailed}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={() => onStart(keyword.trim(), disableFailed)}>
            开始校验
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
