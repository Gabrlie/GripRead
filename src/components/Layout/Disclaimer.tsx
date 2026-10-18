import { useState } from "react";
import { t, type MessageKey } from "../../i18n";
import { requestExit } from "../../services/lifecycle";
import { native } from "../../services/transport";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

/** Raised when the text changes, so everyone is asked again. */
export const DISCLAIMER_VERSION = 1;
const STORAGE_KEY = "gripread.disclaimer";

const ITEMS: MessageKey[] = [
  "disclaimer.purpose",
  "disclaimer.content",
  "disclaimer.translation",
  "disclaimer.data",
  "disclaimer.warranty",
  "disclaimer.rights",
];

/** Whether this device accepted the current text; storage that cannot be read asks again. */
export function disclaimerAccepted(): boolean {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) >= DISCLAIMER_VERSION;
  } catch {
    return false;
  }
}

function accept() {
  try {
    localStorage.setItem(STORAGE_KEY, String(DISCLAIMER_VERSION));
  } catch {
    // Not kept: asked again next time.
  }
}

/** The numbered terms, scrolling inside a bounded box. */
function DisclaimerText() {
  return (
    <div className="max-h-[55dvh] overflow-y-auto space-y-2 text-sm leading-relaxed pr-1">
      <ol className="list-decimal pl-5 space-y-2">
        {ITEMS.map((item) => (
          <li key={item}>{t(item)}</li>
        ))}
      </ol>
      <p className="text-secondary">{t("disclaimer.agreement")}</p>
    </div>
  );
}

/** 关于 › 免责声明: the same text, closable. */
export function DisclaimerDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("disclaimer.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("disclaimer.title")}</DialogDescription>
        </DialogHeader>
        <DisclaimerText />
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The first launch (and the first after the text changes) asks for 同意
 * before the app can be used. 不同意 quits; the web version cannot quit,
 * so it says to close the page and keeps asking.
 */
export function DisclaimerPrompt() {
  const [accepted, setAccepted] = useState(disclaimerAccepted);
  const [declined, setDeclined] = useState(false);
  if (accepted) return null;
  return (
    // Neither Escape, Android back, nor a tap outside closes it.
    <Dialog open disablePointerDismissal onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md p-5 gap-3 z-[120]"
        overlayClassName="z-[120] bg-black/40"
      >
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("disclaimer.title")}
          </DialogTitle>
          <DialogDescription>{t("disclaimer.intro")}</DialogDescription>
        </DialogHeader>
        <DisclaimerText />
        {declined && (
          <p role="status" className="text-xs text-error">
            {t("disclaimer.closePage")}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (!requestExit()) setDeclined(true);
            }}
          >
            {native ? t("disclaimer.declineExit") : t("disclaimer.decline")}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              accept();
              setAccepted(true);
            }}
          >
            {t("disclaimer.accept")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
