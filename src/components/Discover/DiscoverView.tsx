import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
import { DISCOVER_CATEGORIES } from "./discoverData";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export function DiscoverView() {
  return (
    <div className="flex-1 flex flex-col relative w-full pt-14 pb-20 md:pb-8 bg-surface min-w-0">
      <Header title="发现" subtitle="EXPLORE" searchDisabled />

      <main className="flex-1 flex flex-col relative w-full max-w-5xl mx-auto px-4 md:px-8 pb-space-lg space-y-5 pt-2">
        {/* Search & Filter Bar (No duplicate non-header title) */}
        <section className="flex flex-col gap-2 mt-2" aria-label="书源搜索">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Icon
                name="search"
                size={18}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary pointer-events-none"
              />
              <Input
                id="discover-search-input"
                type="text"
                disabled
                title="书源搜索未开放"
                aria-label="搜索书源"
                placeholder="探索书海、作家或特定书源..."
                className="pl-9 pr-8 bg-surface-container border-transparent focus-visible:border-primary text-sm h-10 rounded-xl"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled
              aria-label="筛选配置"
              className="h-10 w-10 bg-surface-container border-transparent text-secondary rounded-xl shrink-0 opacity-60 cursor-not-allowed"
            >
              <Icon name="tune" size={18} />
            </Button>
          </div>
        </section>

        {/* Source Selection Horizontal Pills */}
        <section
          className="overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 pb-1 scrollbar-none"
          aria-label="书源范围"
        >
          <div className="flex items-center space-x-2 whitespace-nowrap">
            {[
              { id: "all", name: "全部书源" },
              { id: "manage", name: "书源管理" },
            ].map((source) => (
              <Button
                key={source.id}
                disabled
                title="书源功能未开放"
                variant={source.id === "all" ? "default" : "secondary"}
                size="sm"
                className={`rounded-full px-3.5 h-8 text-xs font-medium transition-all ${source.id === "all" ? "bg-primary text-on-primary shadow-sm" : "bg-surface-container text-secondary border-transparent"}`}
              >
                {source.name}
              </Button>
            ))}
          </div>
        </section>

        {/* Category Navigation Grid */}
        <section className="flex flex-col space-y-2" aria-labelledby="discover-categories">
          <div className="flex items-center justify-between">
            <h2
              id="discover-categories"
              className="font-title-editorial text-base font-semibold text-on-surface"
            >
              分类索引
            </h2>
            <div className="flex items-center gap-2">
              <span className="font-label-caps text-[11px] text-secondary">
                8 个文学维度 · 未开放
              </span>
            </div>
          </div>

          <div className="grid grid-cols-4 sm:grid-cols-4 md:grid-cols-8 gap-2 pt-1">
            {DISCOVER_CATEGORIES.map((cat) => {
              return (
                <Card
                  key={cat.id}
                  role="button"
                  aria-disabled="true"
                  title="分类发现未开放"
                  className="flex flex-col items-center justify-center p-2 rounded-xl select-none border-transparent ring-0 shadow-none bg-surface-container opacity-50 cursor-not-allowed"
                >
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center mb-1.5 ${cat.color}`}
                  >
                    <Icon name={cat.icon} size={18} />
                  </div>
                  <span className="font-label-md text-xs text-on-surface font-medium">
                    {cat.name}
                  </span>
                </Card>
              );
            })}
          </div>
        </section>

        {/* Featured Editorial Book Recommendations */}
        <section className="flex flex-col space-y-3" aria-labelledby="discover-featured">
          <div className="flex items-center justify-between">
            <h3
              id="discover-featured"
              className="font-title-editorial text-base font-semibold text-on-surface"
            >
              本期主编力荐
            </h3>
            <span className="font-label-caps text-[11px] text-secondary">未开放</span>
          </div>

          <div className="flex flex-col gap-2.5">
            <Card
              aria-disabled="true"
              className="p-3 rounded-xl bg-surface-container-low flex flex-row items-center gap-3.5 border-surface-variant/30 shadow-xs"
            >
              <div
                aria-hidden="true"
                className="relative w-16 aspect-[3/4] rounded-lg overflow-hidden shrink-0 bg-surface-container-high shadow-xs flex items-center justify-center text-secondary/50"
              >
                <Icon name="auto_stories" size={24} />
              </div>
              <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="font-title-editorial text-sm font-semibold text-secondary truncate">
                    精选推荐未开放
                  </h4>
                  <span className="font-label-md text-xs text-secondary shrink-0">—</span>
                </div>
                <p className="font-body-sm text-xs text-secondary truncate">
                  书源接入后显示作品信息
                </p>
                <p className="font-body-sm text-xs text-on-surface-variant line-clamp-1">—</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <Badge
                    variant="secondary"
                    className="text-[10px] h-4 px-1.5 border-transparent bg-secondary/15 text-secondary"
                  >
                    未开放
                  </Badge>
                  <span className="font-label-md text-xs text-secondary truncate">最新：—</span>
                </div>
              </div>
            </Card>
          </div>
        </section>

        {/* Editorial Footnote */}
        <div className="pt-3 text-center">
          <span className="font-label-caps text-xs text-secondary tracking-widest block opacity-70">
            —— 读书如临深渊，思接千载 ——
          </span>
        </div>
      </main>
    </div>
  );
}
