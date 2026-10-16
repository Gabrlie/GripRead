import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import { copyText } from "../../services/system";
import type { BookSourceSummary, SourceCheckEvent } from "../../types/generated";
import {
  basicFilters,
  sourceSorts,
  filterSources,
  checkMessage,
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
import { t } from "../../i18n";

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
      return sourceSorts().some(([value]) => value === kept) ? (kept as SourceSort) : "weight";
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
              current: `${event.name}: ${checkMessage(event.message)}`,
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
    setChecking({
      operationId,
      checked: 0,
      total: urls.length,
      current: t("src.check.preparing"),
      done: false,
    });
    void service
      .check({ operationId, urls, keyword, disableFailed })
      .catch((failure: unknown) => toast({ text: String(failure), error: true }));
  };

  const exportTo = (urls: string[], target: "file" | "clipboard") =>
    target === "file"
      ? void service.exportSourcesFile(urls).then(
          (saved) => saved && toast(t("src.exported", { count: urls.length || sources.length })),
          (failure: unknown) => toast({ text: String(failure), error: true }),
        )
      : void service
          .exportSources(urls)
          .then(copyText)
          .then(
            () => toast(t("src.copied")),
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
      {t("common.done")}
    </Button>
  ) : (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("src.new")}
        className="h-9 w-9 rounded-full text-secondary"
        onClick={() => setEditing("new")}
      >
        <Icon name="add" size={20} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("src.sort")}
          className="h-9 w-9 rounded-full inline-flex items-center justify-center text-secondary hover:bg-surface-container"
        >
          <Icon name="swap_vert" size={19} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={() => setReverse((value) => !value)}>
            <Icon name={reverse ? "check_box" : "check_box_outline"} size={15} />
            {t("src.reverse")}
          </DropdownMenuItem>
          {sourceSorts().map(([value, label]) => (
            <DropdownMenuItem key={value} onClick={() => setSort(value)}>
              <Icon name="check" size={15} className={sort === value ? "" : "opacity-0"} />
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
          <DropdownMenuItem disabled={!sources.length} onClick={() => setSelected(new Set())}>
            <Icon name="checklist" size={15} />
            {t("src.select")}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!sources.length}
            onClick={() => setCheckKeyword(shown.map((source) => source.url))}
          >
            <Icon name="check_circle" size={15} />
            {t("src.checkShown")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!sources.length} onClick={() => exportTo([], "file")}>
            <Icon name="upload" size={15} />
            {t("src.exportAll")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <FullPage label={t("settings.sources")} onClose={onClose} actions={actions}>
      <div className="space-y-2">
        <label className="flex items-center gap-2 rounded-xl bg-surface-container-low px-3 h-10">
          <Icon name="search" size={16} className="text-secondary" />
          <input
            aria-label={t("src.search")}
            placeholder={t("src.search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="flex-1 min-w-0 bg-transparent text-sm outline-none"
          />
          {query && (
            <button type="button" aria-label={t("shelf.search.clear")} onClick={() => setQuery("")}>
              <Icon name="close" size={15} className="text-secondary" />
            </button>
          )}
        </label>
        <div
          className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1"
          role="group"
          aria-label={t("src.filter")}
        >
          {basicFilters().map(([value, label]) => filterChip(value, label))}
          {groups.map((name) => filterChip({ kind: "group", name }, name))}
        </div>
        <p className="px-1 text-[11px] text-secondary">
          {t("src.count", { total: sources.length, enabled: enabledCount })}
          {shown.length !== sources.length && t("src.shown", { count: shown.length })}
        </p>
      </div>

      {loaded && sources.length === 0 && (
        <div className="py-10 text-center space-y-3">
          <p className="text-sm text-secondary">{t("src.none")}</p>
          <div className="flex justify-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setImporting("network")}>
              {t("src.importNetwork")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setImporting("paste")}>
              {t("src.importPaste")}
            </Button>
          </div>
        </div>
      )}

      <ul className="space-y-1.5" aria-label={t("src.list")}>
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
                  aria-label={t("src.selectOne", { name: source.name })}
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
                      aria-label={source.enabledExplore ? t("src.hasExplore") : t("src.exploreOff")}
                    />
                  )}
                  {source.viaServer && (
                    <span
                      className="shrink-0 rounded px-1 text-[10px] leading-4 bg-surface-container text-secondary"
                      title={t("src.viaServer")}
                    >
                      {t("src.viaServerMark")}
                    </span>
                  )}
                  {source.hasLogin && (
                    <Icon
                      name="login"
                      size={12}
                      className="text-secondary"
                      aria-label={t("src.needsLogin")}
                    />
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
                      {t("src.respond", { time: formatRespondTime(source.respondTime) })}
                    </span>
                  )
                )}
              </button>
              {!selected && (
                <>
                  <Switch
                    aria-label={t("src.enableOne", { name: source.name })}
                    checked={source.enabled}
                    onCheckedChange={(on) =>
                      run(() => service.setSwitch([source.url], "enabled", on))
                    }
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={t("src.moreOne", { name: source.name })}
                      className="h-8 w-8 rounded-full inline-flex items-center justify-center text-secondary"
                    >
                      <Icon name="more_vert" size={16} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onClick={() => setEditing(source.url)}>
                        <Icon name="edit" size={15} />
                        {t("common.edit")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => run(() => service.moveSources([source.url], true))}
                      >
                        <Icon name="vertical_align_top" size={15} />
                        {t("src.top")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => run(() => service.moveSources([source.url], false))}
                      >
                        <Icon name="vertical_align_bottom" size={15} />
                        {t("src.bottom")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          run(
                            () => service.setViaServer([source.url], !source.viaServer),
                            source.viaServer ? t("src.viaServerOff") : t("src.viaServerOn"),
                          )
                        }
                      >
                        <Icon name="cloud" size={15} />
                        {t("src.viaServer")}
                        {source.viaServer && <Icon name="check" size={14} className="ml-auto" />}
                      </DropdownMenuItem>
                      {source.hasLogin && (
                        <DropdownMenuItem onClick={() => setLoggingIn(source.url)}>
                          <Icon name="login" size={15} />
                          {t("src.login")}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => setDebugging(source.url)}>
                        <Icon name="bug_report" size={15} />
                        {t("src.debug")}
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
                          {source.enabledExplore ? t("src.exploreDisable") : t("src.exploreEnable")}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => setCheckKeyword([source.url])}>
                        <Icon name="check_circle" size={15} />
                        {t("src.check")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDeleting([source.url])}>
                        <Icon name="delete" size={15} className="text-error" />
                        {t("common.delete")}
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
            <span>{t("src.selected", { selected: selectedUrls.length, total: shown.length })}</span>
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Set(shown.map((s) => s.url)))}
              >
                {t("downloads.selectAll")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSelected(new Set(shown.filter((s) => !selected.has(s.url)).map((s) => s.url)))
                }
              >
                {t("src.invert")}
              </Button>
            </span>
          </div>
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar" aria-label={t("src.batch")}>
            {(
              [
                [
                  t("src.enable"),
                  () => run(() => service.setSwitch(selectedUrls, "enabled", true)),
                ],
                [
                  t("src.disable"),
                  () => run(() => service.setSwitch(selectedUrls, "enabled", false)),
                ],
                [t("detail.group"), () => setGrouping(selectedUrls)],
                [
                  t("src.exploreEnable"),
                  () => run(() => service.setSwitch(selectedUrls, "explore", true)),
                ],
                [
                  t("src.exploreDisable"),
                  () => run(() => service.setSwitch(selectedUrls, "explore", false)),
                ],
                [t("src.top"), () => run(() => service.moveSources(selectedUrls, true))],
                [t("src.bottom"), () => run(() => service.moveSources(selectedUrls, false))],
                [t("common.export"), () => exportTo(selectedUrls, "file")],
                [t("reader.copy"), () => exportTo(selectedUrls, "clipboard")],
                [t("src.check"), () => setCheckKeyword(selectedUrls)],
                [t("common.delete"), () => setDeleting(selectedUrls)],
              ] as [string, () => void][]
            ).map(([label, action]) => (
              <Button
                key={label}
                size="sm"
                variant="outline"
                className={`shrink-0 ${label === t("common.delete") ? "text-error" : ""}`}
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
              {checking.done ? t("src.checkDone") : t("src.checking")} {checking.checked}/
              {checking.total}
            </p>
            {!checking.done && (
              <p className="text-[11px] text-secondary truncate">{checking.current}</p>
            )}
          </div>
          {checking.done ? (
            <Button size="sm" variant="ghost" onClick={() => setChecking(null)}>
              {t("common.close")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void service.cancel(checking.operationId)}
            >
              {t("search.stop")}
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
            if (count) toast(t("src.imported", { count }));
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
            run(
              () => service.changeGroup(urls, group, add),
              add ? t("src.grouped") : t("src.ungrouped"),
            );
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
              <DialogTitle className="font-title-editorial text-base">
                {t("src.deleteTitle")}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-secondary">
              {t("src.deleteAsk", { count: deleting.length })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                className="bg-error text-on-error"
                onClick={() => {
                  const urls = deleting;
                  setDeleting(null);
                  setSelected(null);
                  run(() => service.deleteSources(urls), t("src.deleted", { count: urls.length }));
                }}
              >
                {t("common.delete")}
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
          <DialogTitle className="font-title-editorial text-base">{t("detail.group")}</DialogTitle>
        </DialogHeader>
        <Input
          aria-label={t("groups.name")}
          placeholder={t("src.groupNames")}
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
            {t("common.cancel")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!group.trim()}
            onClick={() => onApply(group, false)}
          >
            {t("src.removeGroup")}
          </Button>
          <Button size="sm" disabled={!group.trim()} onClick={() => onApply(group, true)}>
            {t("src.addGroup")}
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
          <DialogTitle className="font-title-editorial text-base">
            {t("src.checkCount", { count })}
          </DialogTitle>
        </DialogHeader>
        <Input
          aria-label={t("field.check-keyword")}
          placeholder={t("src.checkKeyword")}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            {t("src.byResult")}
            <span className="block text-[11px] text-secondary">{t("src.byResult.note")}</span>
          </span>
          <Switch
            aria-label={t("src.byResult")}
            checked={disableFailed}
            onCheckedChange={setDisableFailed}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => onStart(keyword.trim(), disableFailed)}>
            {t("src.startCheck")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
