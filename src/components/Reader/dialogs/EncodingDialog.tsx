import type { TxtEncoding, TxtEncodingInfo } from "../../../types/generated";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

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
  { encoding: "auto", label: "自动识别" },
  { encoding: "utf8", label: "UTF-8" },
  { encoding: "gbk", label: "GBK", note: "含 GB2312" },
  { encoding: "gb18030", label: "GB18030" },
  { encoding: "utf16_le", label: "UTF-16LE", note: "Unicode" },
  { encoding: "utf16_be", label: "UTF-16BE" },
];

export const ENCODING_NAMES: Record<TxtEncoding, string> = {
  auto: "自动识别",
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
  const locked = !encodingInfo?.canChange || decoding || disabled;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-sm p-4 gap-3">
        <DialogHeader>
          <DialogTitle>设置编码</DialogTitle>
          <DialogDescription>
            {encodingInfo
              ? `识别结果：${ENCODING_NAMES[encodingInfo.detected]}。重新解码只在本机进行。`
              : "正在读取编码信息…"}
          </DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label="文本编码" className="space-y-1">
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
          <p className="text-xs text-error">当前编码出现了无法识别的字符，请换一种编码。</p>
        )}
        {encodingInfo && !encodingInfo.canChange && (
          <div className="space-y-2">
            <p className="text-xs text-secondary">
              这本书没有保留原始字节。重新选择原始 TXT 并通过校验后即可切换编码。
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onReassociate}>
              关联原始 TXT
            </Button>
          </div>
        )}
        {decoding && (
          <div className="flex items-center justify-between gap-3">
            <p role="status" className="text-xs text-secondary">
              正在重新解码…
            </p>
            <Button type="button" variant="outline" size="sm" onClick={onCancelDecode}>
              取消
            </Button>
          </div>
        )}
        {decodeError && (
          <p role="alert" className="text-xs text-error">
            {decodeError}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
