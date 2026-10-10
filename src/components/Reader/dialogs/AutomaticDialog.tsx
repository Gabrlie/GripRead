import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import {
  AUTO_SCROLL_SPEED_MIN,
  AUTO_SCROLL_SPEED_MAX,
  type AutoPageMode,
} from "../../../types/generated";

interface AutomaticPanelProps {
  onClose: () => void;
  scroll: boolean;
  speed: number;
  onSpeed: (speed: number) => void;
  seconds: number;
  disabledInterval: boolean;
  running: boolean;
  canStart: boolean;
  onInterval: (seconds: number) => void;
  onStart: () => void;
  onPause: () => void;
  /** Paginated reading: uncover the next page, or turn with the animation. */
  mode?: AutoPageMode;
  onMode?: (mode: AutoPageMode) => void;
}

/** Legado's AutoReadDialog: page interval or scroll speed, start and pause. */
export function AutomaticDialog({
  onClose,
  scroll,
  speed,
  onSpeed,
  seconds,
  disabledInterval,
  running,
  canStart,
  onInterval,
  onStart,
  onPause,
  mode,
  onMode,
}: AutomaticPanelProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-sm p-4 gap-3">
        <DialogHeader>
          <DialogTitle>自动翻页</DialogTitle>
          <DialogDescription>仅在阅读本书期间自动翻页。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="block space-y-2 text-sm">
            <span className="flex justify-between">
              <span>{scroll ? "滚动速度" : "每屏间隔"}</span>
              <output>{scroll ? `${speed} px/秒` : `${seconds} 秒`}</output>
            </span>
            <input
              aria-label={scroll ? "自动滚动速度" : "自动翻页间隔"}
              type="range"
              min={scroll ? AUTO_SCROLL_SPEED_MIN : 2}
              max={scroll ? AUTO_SCROLL_SPEED_MAX : 60}
              step={1}
              disabled={disabledInterval}
              value={scroll ? speed : seconds}
              onChange={(event) => (scroll ? onSpeed : onInterval)(Number(event.target.value))}
              className="w-full accent-primary"
            />
          </label>
          {!scroll && mode && onMode && (
            <div role="radiogroup" aria-label="翻页方式" className="flex gap-2">
              {(
                [
                  ["reveal", "覆盖"],
                  ["turn", "翻页动画"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={mode === value}
                  onClick={() => onMode(value)}
                  className={`flex-1 h-8 rounded-full text-xs border ${mode === value ? "bg-primary text-on-primary border-primary" : "border-surface-variant"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {running ? (
            <Button variant="outline" onClick={onPause}>
              {scroll ? "暂停自动滚动" : "暂停自动翻页"}
            </Button>
          ) : (
            <Button disabled={!canStart} onClick={onStart}>
              {scroll ? "开始自动滚动" : "开始自动翻页"}
            </Button>
          )}
          <p className="text-xs text-secondary">
            手动翻页、显示工具栏、打开面板或切换到后台时会暂停。
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
