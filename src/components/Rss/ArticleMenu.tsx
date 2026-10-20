import { useFeeds } from "../../application/runtime";
import { useT } from "../../i18n";
import { openExternal } from "../../services/external";
import { copyText } from "../../services/system";
import type { ArticleSummary } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "../ui/dropdown-menu";
import { Icon } from "../ui/Icon";
import { toast } from "../ui/toast";
import type { PressPoint } from "../ui/use-long-press";

/**
 * An article's long-press menu, where the finger was: read or unread,
 * star, 以上/以下标为已读 in the list, 保持未读, and its link.
 */
export function ArticleMenu({
  article,
  point,
  onClose,
}: {
  article: ArticleSummary;
  point: PressPoint;
  onClose: () => void;
}) {
  const t = useT();
  const { store } = useFeeds();
  const act = (work: () => Promise<unknown>, done?: (result: unknown) => string | null) => {
    onClose();
    void work().then(
      (result) => {
        const text = done?.(result);
        if (text) toast(text);
      },
      (error: unknown) => toast({ text: describeError(error), error: true }),
    );
  };
  const marked = (count: unknown) =>
    count ? t("rss.markedRead", { count: count as number }) : t("rss.noUnread");
  const anchor = {
    getBoundingClientRect: () => DOMRect.fromRect({ x: point.x, y: point.y, width: 0, height: 0 }),
  };
  const items: { icon: string; label: string; run: () => void }[] = [
    {
      icon: article.read ? "mark_unread" : "mark_read",
      label: article.read ? t("rss.markUnread") : t("rss.markRead"),
      run: () => act(() => store.setState([article.id], { read: !article.read })),
    },
    {
      icon: "star",
      label: article.starred ? t("rss.unstar") : t("rss.star"),
      run: () => act(() => store.setState([article.id], { starred: !article.starred })),
    },
    {
      icon: "vertical_align_top",
      label: t("rss.markAbove"),
      run: () => act(() => store.markRange(article, true), marked),
    },
    {
      icon: "vertical_align_bottom",
      label: t("rss.markBelow"),
      run: () => act(() => store.markRange(article, false), marked),
    },
    {
      icon: "push_pin",
      label: article.keepUnread ? t("rss.keepUnread.off") : t("rss.keepUnread"),
      run: () =>
        act(() =>
          store.setState(
            [article.id],
            article.keepUnread ? { keepUnread: false } : { keepUnread: true },
          ),
        ),
    },
  ];
  if (article.link) {
    const link = article.link;
    items.push(
      {
        icon: "content_copy",
        label: t("rss.copyLink"),
        run: () =>
          act(
            () => copyText(link),
            () => t("rss.linkCopied"),
          ),
      },
      {
        icon: "open_in_new",
        label: t("rss.openLink"),
        run: () => act(() => openExternal(link)),
      },
    );
  }
  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuContent
        anchor={anchor}
        align="start"
        sideOffset={4}
        aria-label={t("rss.articleMenu")}
        className="w-52"
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            onClick={item.run}
            className="flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-on-surface rounded-xl cursor-pointer hover:bg-surface-container/60 focus:bg-surface-container/60 transition-colors"
          >
            <Icon name={item.icon} size={16} className="text-primary" />
            <span className="flex-1">{item.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
