import { useEffect, useState } from "react";
import type { SourceService } from "../../services/contracts";
import type { SourceSubscription } from "../../types/generated";
import { formatDateTime, t } from "../../i18n";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { reportError, toast } from "../ui/toast";
import { SourceImportDialog } from "./SourceImportDialog";

/**
 * 书源订阅: source lists the reader imports from again by hand. 更新 opens
 * 网络导入 on the address, with the same preview and choices.
 */
export function SourceSubscriptionsPage({
  service,
  onImported,
  onClose,
}: {
  service: SourceService;
  /** After an update saved sources, so 书源管理 lists them. */
  onImported: () => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<SourceSubscription[] | null>(null);
  const [editing, setEditing] = useState<SourceSubscription | null>(null);
  const [updating, setUpdating] = useState<SourceSubscription | null>(null);
  const fail = reportError;

  useEffect(() => {
    void service.listSubscriptions().then(setList, fail);
  }, [service]);

  return (
    <FullPage
      label={t("srcSub.title")}
      onClose={onClose}
      layer="z-[45]"
      actions={
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("srcSub.add")}
          className="h-9 w-9 rounded-full text-secondary"
          onClick={() => setEditing({ id: "", name: "", url: "", updatedAt: null, imported: null })}
        >
          <Icon name="add" size={20} />
        </Button>
      }
    >
      {list && list.length === 0 && (
        <p className="py-8 text-center text-sm text-secondary">{t("srcSub.empty")}</p>
      )}
      <ul className="space-y-1.5" aria-label={t("srcSub.title")}>
        {list?.map((item) => (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-xl bg-surface-container-low px-3 py-2.5"
          >
            <button
              type="button"
              className="flex-1 min-w-0 text-left"
              onClick={() => setEditing(item)}
            >
              <span className="block text-sm truncate">{item.name}</span>
              <span className="block text-[11px] text-secondary truncate">{item.url}</span>
              <span className="block text-[11px] text-secondary">
                {item.updatedAt
                  ? t("srcSub.last", {
                      time: formatDateTime(item.updatedAt),
                      count: item.imported ?? 0,
                    })
                  : t("srcSub.never")}
              </span>
            </button>
            <Button size="sm" variant="outline" onClick={() => setUpdating(item)}>
              {t("srcSub.update")}
            </Button>
          </li>
        ))}
      </ul>

      {editing && (
        <SubscriptionDialog
          subscription={editing}
          onSave={(next) =>
            void service.saveSubscription(next).then((saved) => {
              setList(saved);
              setEditing(null);
            }, fail)
          }
          onDelete={
            editing.id
              ? () =>
                  void service.deleteSubscription(editing.id).then((saved) => {
                    setList(saved);
                    setEditing(null);
                  }, fail)
              : undefined
          }
          onClose={() => setEditing(null)}
        />
      )}
      {updating && (
        <SourceImportDialog
          service={service}
          method="network"
          initialUrl={updating.url}
          subscribed
          onDone={(count) => {
            const id = updating.id;
            setUpdating(null);
            toast(t("srcSub.updated", { count }));
            void service.subscriptionImported(id, count).then(setList, fail);
            onImported();
          }}
          onClose={() => setUpdating(null)}
        />
      )}
    </FullPage>
  );
}

function SubscriptionDialog({
  subscription,
  onSave,
  onDelete,
  onClose,
}: {
  subscription: SourceSubscription;
  onSave: (subscription: SourceSubscription) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(subscription.name);
  const [url, setUrl] = useState(subscription.url);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {subscription.id ? t("srcSub.edit") : t("srcSub.add")}
          </DialogTitle>
        </DialogHeader>
        <label className="block space-y-1 text-xs text-secondary">
          {t("srcSub.name")}
          <Input
            aria-label={t("srcSub.name")}
            value={name}
            placeholder={t("srcSub.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="block space-y-1 text-xs text-secondary">
          {t("srcSub.url")}
          <Input
            aria-label={t("srcSub.url")}
            value={url}
            inputMode="url"
            placeholder="https://…/bookSource.json"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <div className="flex justify-between gap-2">
          {onDelete ? (
            <Button variant="ghost" size="sm" className="text-error" onClick={onDelete}>
              {t("common.delete")}
            </Button>
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!/^https?:\/\//i.test(url.trim())}
              onClick={() => onSave({ ...subscription, name, url })}
            >
              {t("common.save")}
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
