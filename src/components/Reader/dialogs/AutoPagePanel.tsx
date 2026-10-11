import { AUTO_SCROLL_SPEED_MAX, AUTO_SCROLL_SPEED_MIN } from "../../../types/generated";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/Icon";

const INTERVAL_MIN = 2;
const INTERVAL_MAX = 60;

interface AutoPagePanelProps {
  running: boolean;
  scroll: boolean;
  seconds: number;
  speed: number;
  onInterval: (seconds: number) => void;
  onSpeed: (speed: number) => void;
  onPause: () => void;
  onResume: () => void;
  onMenu: () => void;
  onExit: () => void;
  /** Any use of the panel, so it stays while the reader adjusts it. */
  onActivity: () => void;
}

/**
 * Legado's AutoReadDialog while automatic turning is on: a tap on the page
 * shows this panel instead of the reading menu. It reports whether turning
 * runs (with the page animation chosen in 界面), adjusts the interval or
 * scroll speed, pauses
 * or resumes, opens the reading menu, and leaves automatic turning. It does
 * not block the page, so turning continues while it is shown.
 */
export function AutoPagePanel({
  running,
  scroll,
  seconds,
  speed,
  onInterval,
  onSpeed,
  onPause,
  onResume,
  onMenu,
  onExit,
  onActivity,
}: AutoPagePanelProps) {
  const value = scroll ? speed : seconds;
  const [min, max] = scroll
    ? [AUTO_SCROLL_SPEED_MIN, AUTO_SCROLL_SPEED_MAX]
    : [INTERVAL_MIN, INTERVAL_MAX];
  const step = scroll ? 5 : 1;
  const change = (next: number) => {
    const bounded = Math.min(max, Math.max(min, Math.round(next)));
    (scroll ? onSpeed : onInterval)(bounded);
  };
  const status = running ? (scroll ? "自动滚动中" : "自动翻页中") : "已暂停";
  return (
    <section
      role="region"
      aria-label="自动翻页"
      data-reader-control=""
      className="fixed left-3 right-3 bottom-3 z-30 mx-auto max-w-md rounded-2xl bg-surface/95 text-on-surface border border-surface-variant/40 shadow-lg backdrop-blur-sm px-4 py-3 space-y-3"
      style={{ marginBottom: "var(--safe-bottom)" }}
      onPointerDown={onActivity}
      onKeyDown={onActivity}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${running ? "bg-primary animate-pulse" : "bg-outline"}`}
        />
        <p className="flex-1 text-sm font-medium" role="status">
          {status}
          <span className="ml-2 text-[11px] text-secondary font-normal">
            {scroll ? `${speed} px/秒` : `每屏 ${seconds} 秒`}
          </span>
        </p>
        <Button
          variant="ghost"
          size="icon"
          aria-label="退出自动翻页"
          className="h-8 w-8 rounded-full text-secondary"
          onClick={onExit}
        >
          <Icon name="close" size={16} />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label={scroll ? "减慢" : "缩短间隔"}
          className="h-8 w-8 rounded-full shrink-0"
          disabled={value <= min}
          onClick={() => change(value - step)}
        >
          <Icon name="remove" size={15} />
        </Button>
        <input
          aria-label={scroll ? "自动滚动速度" : "自动翻页间隔"}
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => change(Number(event.target.value))}
          className="flex-1 min-w-0 accent-primary"
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={scroll ? "加快" : "延长间隔"}
          className="h-8 w-8 rounded-full shrink-0"
          disabled={value >= max}
          onClick={() => change(value + step)}
        >
          <Icon name="add" size={15} />
        </Button>
      </div>
      <div className="flex gap-2">
        <Button className="flex-1" onClick={running ? onPause : onResume}>
          <Icon name={running ? "pause" : "play"} size={16} />
          {running ? "暂停" : "继续"}
        </Button>
        <Button variant="outline" className="flex-1" onClick={onMenu}>
          <Icon name="more_horiz" size={16} />
          菜单
        </Button>
      </div>
    </section>
  );
}
