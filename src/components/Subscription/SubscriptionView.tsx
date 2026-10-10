import { Header } from "../Layout/Header";
import { Icon } from "../ui/Icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function SubscriptionView() {
  return (
    <div className="flex-1 flex flex-col relative w-full pt-[calc(3.5rem+var(--safe-top))] pb-[calc(5rem+var(--safe-bottom))] md:pb-8 bg-surface min-w-0">
      <Header
        title="订阅"
        subtitle="FEEDS"
        action={
          <Button
            type="button"
            size="sm"
            disabled
            className="flex items-center gap-1 bg-surface-container text-primary font-label-md h-8 px-2.5 rounded-lg border-transparent shadow-xs mr-1 opacity-60 cursor-not-allowed"
            variant="outline"
          >
            <Icon name="add" size={16} />
            <span className="text-xs">添加订阅</span>
          </Button>
        }
      />

      <div className="flex-1 flex flex-col md:flex-row w-full max-w-6xl mx-auto px-4 md:px-8 pt-4 gap-5">
        {/* Left / Top Feed Channels */}
        <section aria-label="订阅频道" className="w-full md:w-64 shrink-0 space-y-3">
          <div className="flex items-center justify-between">
            <span className="font-label-caps text-secondary uppercase tracking-wider text-[11px]">
              订阅频道 · 未开放
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled
              aria-label="刷新订阅"
              className="text-primary text-xs h-6 px-1 opacity-60 cursor-not-allowed"
            >
              <Icon name="refresh" size={13} className="mr-0.5" />
              <span>刷新</span>
            </Button>
          </div>

          <div className="flex md:flex-col gap-1.5 overflow-x-auto scrollbar-none pb-1 md:pb-0">
            <Button
              type="button"
              variant="ghost"
              disabled
              title="订阅管理未开放"
              className="h-auto justify-start py-2 px-3 rounded-xl text-left whitespace-nowrap md:whitespace-normal shrink-0 bg-surface-container text-primary font-medium shadow-xs"
            >
              <div className="w-6 h-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 mr-2.5">
                <Icon name="all_inbox" size={15} />
              </div>
              <span className="text-xs font-medium flex-1">全部订阅文章</span>
            </Button>
          </div>
        </section>

        {/* Right Article List Column */}
        <section aria-label="订阅文章" className="flex-1 min-w-0 flex flex-col space-y-3">
          {/* Article Filter Segment using shadcn Tabs */}
          <div className="flex items-center justify-between border-b border-surface-variant/30 pb-2">
            <Tabs value="all" className="w-auto">
              <TabsList className="bg-surface-container p-0.5 rounded-lg h-7">
                <TabsTrigger
                  disabled
                  title="RSS 阅读未开放"
                  value="all"
                  className="text-xs px-2.5 py-1 rounded-md data-[state=active]:bg-surface data-[state=active]:text-primary data-[state=active]:shadow-xs cursor-pointer"
                >
                  全部
                </TabsTrigger>
                <TabsTrigger
                  disabled
                  title="RSS 阅读未开放"
                  value="unread"
                  className="text-xs px-2.5 py-1 rounded-md data-[state=active]:bg-surface data-[state=active]:text-primary data-[state=active]:shadow-xs cursor-pointer"
                >
                  未读
                </TabsTrigger>
                <TabsTrigger
                  disabled
                  title="RSS 阅读未开放"
                  value="favorites"
                  className="text-xs px-2.5 py-1 rounded-md data-[state=active]:bg-surface data-[state=active]:text-primary data-[state=active]:shadow-xs cursor-pointer"
                >
                  星标收藏
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <span className="text-[11px] text-secondary">未开放</span>
          </div>

          {/* Article Cards Stream */}
          <div className="space-y-2.5">
            <Card
              aria-disabled="true"
              className="p-3.5 rounded-xl bg-surface-container-low shadow-xs space-y-1.5 group border-surface-variant/30"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-secondary font-label-md">
                  RSS 订阅未开放
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled
                  aria-label="收藏文章 · 未开放"
                  className="h-6 w-6 p-0 text-secondary opacity-40"
                >
                  <Icon name="bookmark_border" size={15} />
                </Button>
              </div>
              <h3 className="font-title-editorial text-sm font-semibold text-secondary leading-snug">
                暂无订阅文章
              </h3>
              <p className="font-body-sm text-xs text-secondary line-clamp-2 leading-relaxed">
                接入订阅服务后，可在这里阅读和收藏文章。
              </p>
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
}
