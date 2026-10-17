import { useState } from "react";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { t } from "../../../i18n";
import { describeError } from "../../Cloud/format";

/** Legado's bookmark dialog: the marked text and the reader's note. */
export function BookmarkNoteDialog({
  excerpt,
  note: initialNote,
  editing,
  onSave,
  onClose,
}: {
  excerpt: string;
  note: string;
  /** Editing an existing bookmark rather than adding one. */
  editing: boolean;
  onSave: (note: string) => Promise<void>;
  onClose: () => void;
}) {
  const [note, setNote] = useState(initialNote);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {editing ? t("bookmark.note") : t("reader.addBookmark")}
          </DialogTitle>
        </DialogHeader>
        <blockquote className="text-sm text-secondary border-l-2 border-primary/50 pl-3 line-clamp-4 break-words">
          {excerpt}
        </blockquote>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSaving(true);
            void onSave(note.trim())
              .then(onClose, (failure: unknown) => setError(describeError(failure)))
              .finally(() => setSaving(false));
          }}
        >
          <textarea
            aria-label={t("bookmark.noteLabel")}
            placeholder={t("bookmark.placeholder")}
            autoFocus
            rows={4}
            maxLength={2000}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 resize-y"
          />
          {error && (
            <p role="alert" className="text-xs text-error break-words">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
