import { useState } from "react";
import { useFeeds, useRuntime } from "../../application/runtime";
import type { FeedCandidate } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import { useT } from "../../i18n";

/**
 * 添加订阅: an address (a feed, or a page that names its feeds), the feed to
 * take when a page names several, a name, and a group.
 */
export function AddFeedDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
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
          toast(t("rss.subscribed", { title: feed.title }));
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
          <DialogTitle className="font-title-editorial text-base">{t("rss.add")}</DialogTitle>
          <DialogDescription>{t("rss.add.note")}</DialogDescription>
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
              aria-label={t("rss.address")}
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
              {busy && !candidates ? t("rss.finding") : t("rss.find")}
            </Button>
          </div>
          {candidates && candidates.length > 1 && (
            <fieldset className="space-y-1">
              <legend className="text-xs text-secondary mb-1">{t("rss.several")}</legend>
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
                aria-label={t("rss.name")}
                placeholder={t("rss.name.placeholder")}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <Input
                aria-label={t("rss.group")}
                placeholder={t("rss.group.placeholder")}
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
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || !chosen}>
              {busy && candidates ? t("rss.subscribing") : t("rss.subscribe")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
