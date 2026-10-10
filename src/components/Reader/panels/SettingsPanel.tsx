import type { ReaderPreferences } from "../../../types/generated";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

interface SettingsPanelProps {
  preferences: ReaderPreferences | null;
  onChange: (patch: Partial<ReaderPreferences>) => void;
  onClose: () => void;
}

/** Reading mode, page animation, and typography. Changes preview immediately and save after a pause. */
export function SettingsPanel({ preferences, onChange, onClose }: SettingsPanelProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="bg-surface/95 backdrop-blur-xl border border-surface-variant/50 w-[calc(100%-2rem)] max-w-sm rounded-2xl p-4 sm:p-5 shadow-2xl overflow-y-auto top-auto bottom-24 translate-y-0"
        style={{ maxHeight: "calc(100dvh - 8rem)" }}
      >
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-sm">界面</DialogTitle>
          <DialogDescription className="sr-only">
            调整排版会保留当前阅读位置。TXT 目录、书签和搜索均绑定当前正文版本。
          </DialogDescription>
        </DialogHeader>
        {preferences && (
          <div className="space-y-4 text-xs">
            <div className="space-y-2">
              <span className="text-secondary font-medium">阅读方式</span>
              <div className="grid grid-cols-3 gap-2">
                {(["single", "double", "scroll"] as const).map((readingMode) => (
                  <Button
                    key={readingMode}
                    size="sm"
                    variant={preferences.readingMode === readingMode ? "secondary" : "outline"}
                    aria-pressed={preferences.readingMode === readingMode}
                    onClick={() => onChange({ readingMode })}
                  >
                    {{ single: "单页", double: "双页", scroll: "滚动" }[readingMode]}
                  </Button>
                ))}
              </div>
              {preferences.readingMode === "double" && (
                <p className="text-secondary">窄窗口自动显示单页，展开后恢复双页。</p>
              )}
            </div>
            <div className="space-y-2">
              <span className="text-secondary font-medium">翻页效果</span>
              <div className="grid grid-cols-4 gap-2">
                {(["instant", "curl", "slide", "fade"] as const).map((pageTurnEffect) => (
                  <Button
                    key={pageTurnEffect}
                    size="sm"
                    disabled={preferences.readingMode === "scroll"}
                    variant={
                      preferences.pageTurnEffect === pageTurnEffect ? "secondary" : "outline"
                    }
                    aria-pressed={preferences.pageTurnEffect === pageTurnEffect}
                    onClick={() => onChange({ pageTurnEffect })}
                  >
                    {{ instant: "无", curl: "仿真", slide: "滑动", fade: "淡入" }[pageTurnEffect]}
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
