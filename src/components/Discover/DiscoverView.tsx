import { useEffect, useMemo, useState } from "react";
import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useRuntime } from "../../application/runtime";
import { useOptionalApp } from "../../context/AppContext";
import type { OnlineReturn } from "../../application/online";
import { sourceGroups, splitGroups } from "../../application/sources";
import type {
  BookSourceSummary,
  ExploreKind,
  LibraryBook,
  SearchScope,
} from "../../types/generated";
import { SearchPage } from "../Online/SearchPage";
import { ExploreListPage } from "../Online/ExploreListPage";
import { SourceManagePage } from "../Sources/SourceManagePage";
import { SourceEditPage } from "../Sources/SourceEditPage";
import { toast } from "../ui/toast";
import { t } from "../../i18n";

/** The gap between kinds, in pixels (`gap-1.5`). */
const KIND_GAP = 6;

/**
 * A kind's flex sizing from Legado's `layout_flexBasisPercent` and
 * `layout_flexGrow`. The basis leaves room for the gaps, so four kinds of
 * 25% share a row.
 */
export function kindFlex(kind: ExploreKind): { flexBasis?: string; flexGrow?: number } {
  const percent = Number(kind.style?.layout_flexBasisPercent);
  const grow = Number(kind.style?.layout_flexGrow);
  const flex: { flexBasis?: string; flexGrow?: number } = {};
  if (percent > 0) {
    const share = Math.min(percent, 1);
    flex.flexBasis =
      share >= 1 ? "100%" : `calc(${share * 100}% - ${(KIND_GAP * (1 - share)).toFixed(2)}px)`;
  }
  if (grow > 0) flex.flexGrow = grow;
  return flex;
}

/**
 * Legado's 发现: sources with explore categories, one expanded at a time;
 * a category opens its book list. The header search asks every enabled
 * source.
 */
export function DiscoverView() {
  const runtime = useRuntime();
  const service = runtime.services.sources;
  const app = useOptionalApp();
  // Coming back from reading an online book restores the page it came from.
  const [back, setBack] = useState(() => app?.takeOnlineReturn() ?? null);
  const [sources, setSources] = useState<BookSourceSummary[] | null>(null);
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Record<string, ExploreKind[] | "loading" | string>>({});
  const [opened, setOpened] = useState<{
    source: Pick<BookSourceSummary, "url" | "name">;
    kind: ExploreKind;
  } | null>(
    back?.view === "explore"
      ? { source: { url: back.sourceUrl, name: back.sourceName }, kind: back.kind }
      : null,
  );
  const [searching, setSearching] = useState<SearchScope | null>(
    back?.view === "search" ? back.scope : null,
  );

  /** Opens a kept online book, at a chapter when one was chosen. */
  const read = (book: LibraryBook, chapter: number | null, from: OnlineReturn) => {
    if (!app) return;
    const open = () => app.openReader(book, undefined, from);
    if (chapter === null) {
      open();
      return;
    }
    void runtime.services.reader
      .resolveOffset({
        bookId: book.book.id,
        contentVersion: "",
        resourceId: `chapter-${chapter}`,
        offset: 0,
      })
      .then((locator) => runtime.services.reader.saveReaderLocator(locator))
      .then(open, (failure: unknown) => toast({ text: String(failure), error: true }));
  };
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = () =>
    service.listSources().then(setSources, (failure: unknown) => {
      setSources([]);
      toast({ text: String(failure), error: true });
    });
  useEffect(() => {
    void load();
  }, [service]);

  const explorable = useMemo(
    () =>
      (sources ?? []).filter(
        (source) => source.enabled && source.hasExplore && source.enabledExplore,
      ),
    [sources],
  );
  const groups = useMemo(() => sourceGroups(explorable), [explorable]);
  const shown = explorable.filter(
    (source) =>
      (!group || splitGroups(source.group).includes(group)) &&
      source.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const loadKinds = (source: BookSourceSummary, refresh = false) => {
    setKinds((current) => ({ ...current, [source.url]: "loading" }));
    void service.exploreKinds(source.url, refresh).then(
      (list) => setKinds((current) => ({ ...current, [source.url]: list })),
      (failure: unknown) => setKinds((current) => ({ ...current, [source.url]: String(failure) })),
    );
  };

  const toggle = (source: BookSourceSummary) => {
    if (expanded === source.url) {
      setExpanded(null);
      return;
    }
    setExpanded(source.url);
    if (!kinds[source.url] || typeof kinds[source.url] === "string") loadKinds(source);
  };

  return (
    <div className="flex-1 flex flex-col relative w-full pt-[calc(3.5rem+var(--safe-top))] pb-[calc(5rem+var(--safe-bottom))] md:pb-8 bg-surface min-w-0">
      <Header
        title={t("nav.discover")}
        subtitle="EXPLORE"
        onSearchClick={() => setSearching({ groups: [], sourceUrls: [] })}
        menuItems={[
          { icon: "public", label: t("settings.sources"), onSelect: () => setManaging(true) },
          { icon: "refresh", label: t("logs.refresh"), onSelect: () => void load() },
        ]}
      />
      <main className="flex-1 w-full max-w-3xl mx-auto px-4 md:px-8 space-y-3 pt-3">
        <section aria-label={t("discover.search")} className="space-y-2">
          <label className="flex items-center gap-2 rounded-xl bg-surface-container-low px-3 h-10">
            <Icon name="search" size={16} className="text-secondary" />
            <input
              aria-label={t("discover.filter")}
              placeholder={t("change.filter")}
              value={filter}
              onChange={(change) => setFilter(change.target.value)}
              className="flex-1 min-w-0 bg-transparent text-sm outline-none"
            />
          </label>
          {groups.length > 0 && (
            <div
              className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1"
              role="group"
              aria-label={t("discover.scope")}
            >
              {[null, ...groups].map((name) => (
                <button
                  key={name ?? t("downloads.all")}
                  type="button"
                  aria-pressed={group === name}
                  onClick={() => setGroup(name)}
                  className={`shrink-0 h-7 px-3 rounded-full text-xs ${
                    group === name
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container-low text-secondary"
                  }`}
                >
                  {name ?? t("downloads.all")}
                </button>
              ))}
            </div>
          )}
        </section>

        {sources !== null && explorable.length === 0 && (
          <div className="py-12 text-center space-y-3">
            <p className="text-sm text-secondary">
              {sources.length === 0 ? t("discover.noSources") : t("discover.noCategories")}
            </p>
            <Button size="sm" variant="outline" onClick={() => setManaging(true)}>
              {t("settings.sources")}
            </Button>
          </div>
        )}

        <ul className="space-y-1.5" aria-label={t("discover.sources")}>
          {shown.map((source) => {
            const state = kinds[source.url];
            const open = expanded === source.url;
            return (
              <li key={source.url} className="rounded-xl bg-surface-container-low overflow-hidden">
                <div className="flex items-center">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => toggle(source)}
                    className="flex-1 min-w-0 text-left px-3 py-3 text-sm flex items-center gap-2"
                  >
                    <Icon
                      name={open ? "expand_less" : "expand_more"}
                      size={16}
                      className="text-secondary"
                    />
                    <span className="truncate">{source.name}</span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={t("src.moreOne", { name: source.name })}
                      className="h-9 w-9 mr-1 rounded-full inline-flex items-center justify-center text-secondary"
                    >
                      <Icon name="more_vert" size={16} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        disabled={!source.hasSearch}
                        onClick={() => setSearching({ groups: [], sourceUrls: [source.url] })}
                      >
                        <Icon name="search" size={15} />
                        {t("discover.searchHere")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          setExpanded(source.url);
                          loadKinds(source, true);
                        }}
                      >
                        <Icon name="refresh" size={15} />
                        {t("discover.refreshKinds")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setEditing(source.url)}>
                        <Icon name="edit" size={15} />
                        {t("srcEdit.edit")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {open && (
                  <div className="px-3 pb-3">
                    {state === "loading" && (
                      <p role="status" className="text-xs text-secondary">
                        {t("discover.loading")}
                      </p>
                    )}
                    {typeof state === "string" && state !== "loading" && (
                      <p role="alert" className="text-xs text-error break-words">
                        {state}
                      </p>
                    )}
                    {Array.isArray(state) && state.length === 0 && (
                      <p className="text-xs text-secondary">{t("discover.none")}</p>
                    )}
                    {Array.isArray(state) && state.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {state.map((kind, index) =>
                          kind.title.startsWith("ERROR:") ? (
                            <p key={index} className="basis-full text-xs text-error break-words">
                              {kind.title.slice(6)}
                            </p>
                          ) : (
                            <button
                              key={`${kind.title}-${index}`}
                              type="button"
                              disabled={!kind.url}
                              onClick={() => kind.url && setOpened({ source, kind })}
                              style={kindFlex(kind)}
                              className={`h-8 px-3 rounded-lg text-xs truncate ${
                                kind.url
                                  ? "bg-surface text-on-surface hover:bg-surface-container"
                                  : "text-secondary font-medium"
                              }`}
                            >
                              {kind.title}
                            </button>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </main>

      {opened && (
        <ExploreListPage
          service={service}
          sourceUrl={opened.source.url}
          sourceName={opened.source.name}
          kind={opened.kind}
          restored={back?.view === "explore" ? back : undefined}
          onRead={read}
          onClose={() => {
            setBack(null);
            setOpened(null);
          }}
        />
      )}
      {searching && (
        <SearchPage
          service={service}
          initialScope={searching}
          initialKey={back?.view === "search" ? back.key : ""}
          restored={back?.view === "search" ? back : undefined}
          onRead={read}
          onClose={() => {
            setBack(null);
            setSearching(null);
          }}
        />
      )}
      {managing && (
        <SourceManagePage
          service={service}
          onClose={() => {
            setManaging(false);
            void load();
          }}
        />
      )}
      {editing && (
        <SourceEditPage
          service={service}
          url={editing}
          onSaved={() => void load()}
          onDebug={() => undefined}
          onLogin={() => undefined}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
