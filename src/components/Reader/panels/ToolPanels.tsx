import type {
  Bookmark,
  TocEntry,
  TxtEncoding,
  TxtEncodingInfo,
  TxtTocRule,
} from "../../../types/generated";
import { Button } from "../../ui/button";
import type { ReaderSearch } from "../use-reader-search";
import type { ReaderTools } from "../use-reader-tools";

/** Contents shows recognized chapters or a whole-text entry. */
export type ContentsMode = "auto" | "full";

const selectClass =
  "w-full rounded-lg border border-surface-variant bg-surface-container px-3 py-2";

interface EncodingPanelProps {
  encodingInfo: TxtEncodingInfo | null;
  decoding: boolean;
  decodeError: string | null;
  disabled: boolean;
  onChange: (encoding: TxtEncoding) => void;
  onReassociate: () => void;
  onCancelDecode: () => void;
}

export function EncodingPanel({
  encodingInfo,
  decoding,
  decodeError,
  disabled,
  onChange,
  onReassociate,
  onCancelDecode,
}: EncodingPanelProps) {
  return (
    <div className="space-y-3">
      <label htmlFor="reader-encoding" className="block text-sm">
        文本编码
      </label>
      <select
        id="reader-encoding"
        autoFocus
        className={selectClass}
        value={encodingInfo?.selected ?? "auto"}
        disabled={!encodingInfo?.canChange || decoding || disabled}
        onChange={(event) => onChange(event.target.value as TxtEncoding)}
      >
        <option value="auto">自动识别</option>
        <option value="utf8">UTF-8</option>
        <option value="gb18030">GB18030</option>
        <option value="gbk">GBK</option>
        <option value="utf16_le">UTF-16 LE</option>
        <option value="utf16_be">UTF-16 BE</option>
      </select>
      {encodingInfo?.state === "replacement_characters" && (
        <p className="text-xs text-error">当前编码包含替换字符，请尝试其他编码。</p>
      )}
      {encodingInfo && !encodingInfo.canChange && (
        <div className="space-y-2">
          <p className="text-xs text-secondary">
            旧书籍没有保留原始字节。选择原始 TXT 并完成校验后即可切换编码。
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onReassociate}>
            关联原始 TXT
          </Button>
        </div>
      )}
      {decoding && (
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-xs text-secondary">
            正在重建正文缓存…
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onCancelDecode}>
            取消转换
          </Button>
        </div>
      )}
      {decodeError && (
        <p role="alert" className="text-xs text-error">
          {decodeError}
        </p>
      )}
    </div>
  );
}

export function DirectoryPanel({
  tools,
  totalLength,
}: {
  tools: ReaderTools;
  totalLength: number;
}) {
  const disabled = tools.ruleBusy || tools.loading || Boolean(tools.error);
  const busyWith = tools.ruleBusy ? tools.ruleOperation.current : null;
  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span>章节识别规则</span>
        <select
          autoFocus
          disabled={disabled}
          className={selectClass}
          value={tools.ruleDraft.mode}
          onChange={(event) =>
            tools.setRuleDraft((current) => ({
              ...current,
              mode: event.target.value as TxtTocRule["mode"],
            }))
          }
        >
          <option value="automatic">自动识别中英文</option>
          <option value="chinese">中文章节</option>
          <option value="english">英文 Chapter</option>
          <option value="custom">自定义正则</option>
        </select>
      </label>
      {tools.ruleDraft.mode === "custom" && (
        <label className="block space-y-1 text-sm">
          <span>每行匹配一个章节标题</span>
          <input
            className={`${selectClass} font-mono text-xs`}
            disabled={disabled}
            value={tools.ruleDraft.pattern}
            placeholder="^第.+章.*$"
            onChange={(event) => {
              const pattern = event.target.value;
              tools.setRuleDraft((current) => ({ ...current, pattern }));
            }}
          />
        </label>
      )}
      {tools.ruleError && (
        <p role="alert" className="text-sm text-error">
          {tools.ruleError}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void tools.previewDirectory()} disabled={disabled}>
          {busyWith === "preview" ? "正在预览…" : "预览"}
        </Button>
        <Button onClick={tools.applyDirectory} disabled={disabled || tools.rulePreview === null}>
          {busyWith === "save" ? "正在应用…" : "应用本书"}
        </Button>
        <Button
          variant="ghost"
          disabled={
            disabled || (tools.tocRule.mode === "automatic" && tools.ruleDraft.mode === "automatic")
          }
          onClick={tools.restoreDefaultDirectory}
        >
          恢复默认
        </Button>
      </div>
      {tools.rulePreview !== null && (
        <div className="space-y-2">
          <p role="status" className="text-xs text-secondary">
            预览到 {tools.rulePreview.length} 个章节；确认应用后才会替换本书目录。
          </p>
          <div className="max-h-64 overflow-auto rounded-lg border border-surface-variant/40 p-2">
            {tools.rulePreview.length === 0 ? (
              <p className="p-2 text-sm text-secondary">没有匹配章节，可从全文开始阅读。</p>
            ) : (
              tools.rulePreview.map((entry) => (
                <div
                  key={`${entry.ordinal}-${entry.locator.offset}`}
                  className="flex justify-between gap-3 p-2 text-xs"
                >
                  <span className="truncate">{entry.title}</span>
                  <span className="shrink-0 text-secondary">
                    {totalLength
                      ? `${Math.floor((entry.locator.offset / totalLength) * 100)}%`
                      : `第 ${entry.ordinal + 1} 章`}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface AutomaticPanelProps {
  seconds: number;
  disabledInterval: boolean;
  running: boolean;
  canStart: boolean;
  onInterval: (seconds: number) => void;
  onStart: () => void;
  onPause: () => void;
}

export function AutomaticPanel({
  seconds,
  disabledInterval,
  running,
  canStart,
  onInterval,
  onStart,
  onPause,
}: AutomaticPanelProps) {
  return (
    <div className="space-y-4">
      <label className="block space-y-2 text-sm">
        <span className="flex justify-between">
          <span>每页间隔</span>
          <output>{seconds} 秒</output>
        </span>
        <input
          aria-label="自动翻页间隔"
          type="range"
          min={2}
          max={60}
          step={1}
          disabled={disabledInterval}
          value={seconds}
          onChange={(event) => onInterval(Number(event.target.value))}
          className="w-full accent-primary"
        />
      </label>
      {running ? (
        <Button variant="outline" onClick={onPause}>
          暂停自动翻页
        </Button>
      ) : (
        <Button disabled={!canStart} onClick={onStart}>
          开始自动翻页
        </Button>
      )}
      <p className="text-xs text-secondary">手动翻页、显示工具栏、打开面板或切换到后台时会暂停。</p>
    </div>
  );
}

interface ContentsPanelProps {
  /** Owned by the reader session so the choice survives closing the panel. */
  mode: ContentsMode;
  onModeChange: (mode: ContentsMode) => void;
  toc: TocEntry[];
  toolsLoading: boolean;
  toolsError: string | null;
  onSeek: (entry: TocEntry) => void;
  onStart: () => void;
}

export function ContentsPanel({
  mode,
  onModeChange,
  toc,
  toolsLoading,
  toolsError,
  onSeek,
  onStart,
}: ContentsPanelProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="tablist" aria-label="目录模式">
        <Button
          variant={mode === "auto" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={mode === "auto"}
          onClick={() => onModeChange("auto")}
        >
          自动识别
        </Button>
        <Button
          variant={mode === "full" ? "secondary" : "ghost"}
          role="tab"
          aria-selected={mode === "full"}
          onClick={() => onModeChange("full")}
        >
          全文
        </Button>
      </div>
      <div className="max-h-80 overflow-auto space-y-1">
        {mode === "full" ? (
          <Button variant="ghost" className="w-full justify-start" onClick={onStart}>
            从开头阅读
          </Button>
        ) : (
          <>
            {toc.length === 0 && !toolsLoading && !toolsError && (
              <p className="text-sm text-secondary">未识别到章节，全文阅读。</p>
            )}
            {toc.map((entry) => (
              <Button
                key={`${entry.ordinal}-${entry.locator.offset}`}
                variant="ghost"
                className="w-full justify-start"
                onClick={() => onSeek(entry)}
              >
                {entry.title}
              </Button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

interface MorePanelProps {
  bookmarks: Bookmark[];
  contentVersion: string | undefined;
  canBookmark: boolean;
  canSave: boolean;
  toolsLoading: boolean;
  toolsError: string | null;
  onAddBookmark: () => void;
  onSave: () => void;
  onOpenBookmark: (bookmark: Bookmark) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
}

export function MorePanel({
  bookmarks,
  contentVersion,
  canBookmark,
  canSave,
  toolsLoading,
  toolsError,
  onAddBookmark,
  onSave,
  onOpenBookmark,
  onDeleteBookmark,
}: MorePanelProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Button variant="outline" disabled={!canBookmark} onClick={onAddBookmark}>
          添加当前位置书签
        </Button>
        <Button data-testid="reader-save" variant="outline" disabled={!canSave} onClick={onSave}>
          保存进度
        </Button>
      </div>
      <div className="max-h-80 overflow-auto space-y-2">
        {bookmarks.length === 0 && !toolsLoading && !toolsError && (
          <p className="text-sm text-secondary">还没有书签。</p>
        )}
        {bookmarks.map((bookmark) => (
          <div key={bookmark.id} className="flex gap-2 items-start">
            <Button
              variant="ghost"
              className="flex-1 justify-start text-left h-auto whitespace-normal"
              onClick={() => onOpenBookmark(bookmark)}
            >
              <span>
                {bookmark.excerpt || "当前位置"}
                {bookmark.contentVersion !== contentVersion && (
                  <span className="block text-xs text-secondary mt-1">旧版本书签 · 待重新定位</span>
                )}
              </span>
            </Button>
            <Button
              variant="ghost"
              aria-label="删除书签"
              onClick={() => onDeleteBookmark(bookmark)}
            >
              删除
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SearchPanel({
  search,
  onOpenMatch,
}: {
  search: ReaderSearch;
  onOpenMatch: (match: ReaderSearch["matches"][number]) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          autoFocus
          aria-label="搜索关键词"
          className="flex-1 rounded-lg border border-surface-variant bg-surface-container px-3 py-2"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") search.search();
          }}
        />
        <Button onClick={search.search} disabled={search.searching || !search.query.trim()}>
          搜索
        </Button>
      </div>
      {search.searching && (
        <p role="status" className="text-sm text-secondary">
          正在搜索…
        </p>
      )}
      {search.error && (
        <div role="alert" className="text-sm text-error">
          {search.error}
          <Button size="sm" variant="outline" onClick={search.search}>
            重试搜索
          </Button>
        </div>
      )}
      {search.complete && !search.error && search.matches.length === 0 && !search.searching && (
        <p className="text-sm text-secondary">没有找到匹配内容。</p>
      )}
      <div className="max-h-64 overflow-auto space-y-1">
        {search.matches.map((match) => (
          <Button
            key={`${match.ordinal}-${match.locator.offset}`}
            variant="ghost"
            className="w-full justify-start text-left h-auto whitespace-normal"
            onClick={() => onOpenMatch(match)}
          >
            {match.excerpt}
          </Button>
        ))}
      </div>
      {search.hasMore && (
        <Button variant="outline" onClick={search.loadMore} disabled={search.searching}>
          {search.searching ? "正在搜索…" : "加载更多"}
        </Button>
      )}
    </div>
  );
}
