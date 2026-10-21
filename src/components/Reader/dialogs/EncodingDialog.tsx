import type { TxtEncoding, TxtEncodingInfo } from "../../../types/generated";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { t } from "../../../i18n";
import { useErrorToast } from "../../ui/toast";

interface EncodingDialogProps {
  encodingInfo: TxtEncodingInfo | null;
  decoding: boolean;
  decodeError: string | null;
  disabled: boolean;
  onChange: (encoding: TxtEncoding) => void;
  onReassociate: () => void;
  onCancelDecode: () => void;
  onClose: () => void;
}

/** Legado's charset names mapped onto the decoders GripRead supports. */
const CHOICES: { encoding: TxtEncoding; label: string; note?: string }[] = [
  {
    encoding: "auto",
    get label() {
      return t("reader.encoding.auto");
    },
  },
  { encoding: "utf8", label: "UTF-8" },
  {
    encoding: "gbk",
    label: "GBK",
    get note() {
      return t("reader.encoding.gbkNote");
    },
  },
  { encoding: "gb18030", label: "GB18030" },
  { encoding: "utf16_le", label: "UTF-16LE", note: "Unicode" },
  { encoding: "utf16_be", label: "UTF-16BE" },
];

export const ENCODING_NAMES: Record<TxtEncoding, string> = {
  get auto() {
    return t("reader.encoding.auto");
  },
  utf8: "UTF-8",
  gbk: "GBK",
  gb18030: "GB18030",
  utf16_le: "UTF-16LE",
  utf16_be: "UTF-16BE",
};

/** Legado's 设置编码: re-decode the retained original bytes of this TXT. */
export function EncodingDialog({
  encodingInfo,
  decoding,
  decodeError,
  disabled,
  onChange,
  onReassociate,
  onCancelDecode,
  onClose,
}: EncodingDialogProps) {
  const selected = encodingInfo?.selected ?? "auto";
  useErrorToast(decodeError, "reader-decode");
  const locked = !encodingInfo?.canChange || decoding || disabled;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-sm p-4 gap-3">
        <DialogHeader>
          <DialogTitle>{t("reader.setEncoding")}</DialogTitle>
          <DialogDescription>
            {encodingInfo
              ? t("reader.encoding.detected", { name: ENCODING_NAMES[encodingInfo.detected] })
              : t("reader.encoding.loading")}
          </DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t("detail.encoding")} className="space-y-1">
          {CHOICES.map((choice) => (
            <button
              key={choice.encoding}
              role="radio"
              aria-checked={selected === choice.encoding}
              disabled={locked}
              className={`w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-sm text-left transition-colors disabled:opacity-60 ${selected === choice.encoding ? "bg-surface-container text-primary font-medium" : "hover:bg-surface-container/60"}`}
              onClick={() => selected !== choice.encoding && onChange(choice.encoding)}
            >
              <span>{choice.label}</span>
              {choice.note && <span className="text-[11px] text-secondary">{choice.note}</span>}
            </button>
          ))}
        </div>
        {encodingInfo?.state === "replacement_characters" && (
          <p className="text-xs text-error">{t("reader.encoding.bad")}</p>
        )}
        {encodingInfo && !encodingInfo.canChange && (
          <div className="space-y-2">
            <p className="text-xs text-secondary">{t("reader.encoding.noSource")}</p>
            <Button type="button" variant="outline" size="sm" onClick={onReassociate}>
              {t("reader.encoding.link")}
            </Button>
          </div>
        )}
        {decoding && (
          <div className="flex items-center justify-between gap-3">
            <p role="status" className="text-xs text-secondary">
              {t("reader.encoding.decoding")}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onCancelDecode}>
              {t("common.cancel")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
