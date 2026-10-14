import { useState } from "react";
import { useFeeds, useRuntime } from "../../application/runtime";
import type { FeedCandidate } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";

/**
 * 添加订阅: an address (a feed, or a page that names its feeds), the feed to
 * take when a page names several, a name, and a group.
 */
export function AddFeedDialog({ onClose }: { onClose: () => void }) {
  const service = useRuntime().services.feeds;
  const { state, store } = useFeeds();
  const [address, setAddress] = useState("");
  const [candidates, setCandidates] = useState<FeedCandidate[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = [...new Set(state.feeds.map((feed) => feed.group).filter(Boolean))] as string[];

  const find = () => {
    setBusy(true);
    void service
      .discover(address.trim())
      .then(
        (found) => {
          setCandidates(found);
          setChosen(found[0]?.url ?? null);
          setTitle((current) => current || found[0]?.title || "");
        },
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => setBusy(false));
  };
  const add = () => {
    if (!chosen) return;
    setBusy(true);
    void store
      .addFeed(chosen, title.trim() || null, group.trim() || null)
      .then(
        (feed) => {
          toast(`已订阅：${feed.title}`);
          onClose();
        },
        (error: unknown) => toast({ text: describeError(error), error: true }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">添加订阅</DialogTitle>
          <DialogDescription>输入 RSS、Atom 地址，或网站首页地址。</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (candidates && chosen) add();
            else find();
          }}
        >
          <div className="flex gap-2">
            <Input
              aria-label="订阅地址"
              placeholder="https://example.com/feed"
              inputMode="url"
              autoCapitalize="none"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setCandidates(null);
                setChosen(null);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !address.trim()}
              onClick={find}
            >
              {busy && !candidates ? "查找中…" : "查找"}
            </Button>
          </div>
          {candidates && candidates.length > 1 && (
            <fieldset className="space-y-1">
              <legend className="text-xs text-secondary mb-1">这个网站有多个订阅</legend>
              {candidates.map((candidate) => (
                <label key={candidate.url} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="feed"
                    checked={chosen === candidate.url}
                    onChange={() => {
                      setChosen(candidate.url);
                      setTitle(candidate.title);
                    }}
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    {candidate.title}
                    <span className="block text-[11px] text-secondary break-all">
                      {candidate.url}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {candidates && (
            <>
              <Input
                aria-label="名称"
                placeholder="名称（留空使用订阅自带的标题）"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <Input
                aria-label="分组"
                placeholder="分组（可选）"
                list="rss-groups"
                value={group}
                onChange={(event) => setGroup(event.target.value)}
              />
              <datalist id="rss-groups">
                {groups.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={busy || !chosen}>
              {busy && candidates ? "订阅中…" : "订阅"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
