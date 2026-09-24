import type { ReaderPreferences } from "../../../types/generated";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Icon } from "../../ui/Icon";
import { PanelStatus, type PanelStatusProps } from "./PanelShell";

interface SettingsPanelProps {
  preferences: ReaderPreferences | null;
  onChange: (patch: Partial<ReaderPreferences>) => void;
  onClose: () => void;
  status: PanelStatusProps;
}

const PAPER_TONES = [
  { tone: "warm-tea", label: "柔雅暖茶", color: "#f6f2e9" },
  { tone: "bone-white", label: "羊脂白", color: "#faf8f5" },
  { tone: "xuan-paper", label: "宣纸微黄", color: "#f3ece0" },
  { tone: "jade-green", label: "墨绿温润", color: "#e7ebe4" },
] as const;

/** Theme and typography controls. Changes preview immediately and save after a pause. */
export function SettingsPanel({ preferences, onChange, onClose, status }: SettingsPanelProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="bg-surface/95 backdrop-blur-xl border border-surface-variant/50 w-[calc(100%-2rem)] max-w-sm rounded-2xl p-4 sm:p-5 shadow-2xl overflow-y-auto top-auto bottom-24 translate-y-0"
        style={{ maxHeight: "calc(100dvh - 8rem)" }}
      >
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-sm">排版与纸张微调</DialogTitle>
          <DialogDescription className="sr-only">
            调整排版会保留当前阅读位置。TXT 目录、书签和搜索均绑定当前正文版本。
          </DialogDescription>
        </DialogHeader>
        <PanelStatus {...status} />
        {preferences && (
          <div className="space-y-4 text-xs">
            <div className="space-y-2">
              <span className="text-secondary font-medium">界面主题</span>
              <div className="grid grid-cols-3 gap-2">
                {(["system", "light", "dark"] as const).map((theme) => (
                  <Button
                    key={theme}
                    variant="outline"
                    size="sm"
                    aria-pressed={preferences.theme === theme}
                    onClick={() => onChange({ theme })}
                  >
                    {{ system: "跟随系统", light: "日间", dark: "夜间" }[theme]}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-secondary font-medium">字号大小</span>
              <div className="flex items-center gap-2">
                <Button
                  aria-label="减小字号"
                  variant="secondary"
                  size="sm"
                  onClick={() => onChange({ fontSize: Math.max(14, preferences.fontSize - 1) })}
                  className="h-7 px-2.5 bg-surface-container font-medium text-xs"
                >
                  A-
                </Button>
                <span className="w-8 text-center text-primary font-semibold">
                  {preferences.fontSize}px
                </span>
                <Button
                  aria-label="增大字号"
                  variant="secondary"
                  size="sm"
                  onClick={() => onChange({ fontSize: Math.min(32, preferences.fontSize + 1) })}
                  className="h-7 px-2.5 bg-surface-container font-medium text-xs"
                >
                  A+
                </Button>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-secondary">行距</span>
              <div className="flex gap-1.5">
                {[1.6, 1.8, 2].map((height) => (
                  <Button
                    key={height}
                    variant="secondary"
                    size="sm"
                    aria-pressed={preferences.lineHeight === height}
                    className={`h-7 px-2 text-xs ${preferences.lineHeight === height ? "bg-primary text-on-primary" : "bg-surface-container text-secondary"}`}
                    onClick={() => onChange({ lineHeight: height })}
                  >
                    {height}x
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {PAPER_TONES.map(({ tone, label, color }) => (
                <button
                  key={tone}
                  aria-label={label}
                  aria-pressed={preferences.paperTone === tone}
                  onClick={() => onChange({ paperTone: tone })}
                  className={`h-8 rounded-lg border border-black/10 flex items-center justify-center ${preferences.paperTone === tone ? "ring-2 ring-primary" : ""}`}
                  style={{ background: color }}
                >
                  {preferences.paperTone === tone && (
                    <Icon name="check" size={14} className="text-primary" />
                  )}
                </button>
              ))}
            </div>
            <div className="border-t border-surface-variant/30 pt-3 space-y-2">
              <span className="text-xs text-secondary">字体</span>
              <div className="grid grid-cols-2 gap-2">
                {(["serif", "sans"] as const).map((font) => (
                  <Button
                    key={font}
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    aria-pressed={preferences.fontFamily === font}
                    onClick={() => onChange({ fontFamily: font })}
                  >
                    {font === "serif" ? "思源宋体" : "系统黑体"}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
