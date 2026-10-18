import type { ComicPreferences } from "../../types/generated";
import { t, type MessageKey } from "../../i18n";
import { Dialog, DialogHeader, DialogTitle, SheetContent } from "../ui/dialog";
import { Switch } from "../ui/switch";

/** A row of choices, one of which is on; each is named `${name}.${option}`. */
function Choices<T extends string>({
  name,
  value,
  options,
  onChange,
  note,
}: {
  name: "comic.mode" | "comic.direction" | "comic.fit" | "comic.background";
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  note?: string;
}) {
  const label = t(name);
  return (
    <div className="space-y-1.5">
      <span className="text-sm">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid gap-1 bg-surface-container p-1 rounded-lg"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            onClick={() => value !== option && onChange(option)}
            className={`min-h-7 rounded-md px-1 text-xs truncate ${value === option ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
          >
            {t(`${name}.${option}` as MessageKey)}
          </button>
        ))}
      </div>
      {note && <p className="text-[11px] text-secondary">{note}</p>}
    </div>
  );
}

/** A setting with a number from a slider. */
function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm">
      <span className="shrink-0">{label}</span>
      <input
        type="range"
        aria-label={label}
        className="flex-1 min-w-0 accent-[var(--color-primary)]"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-8 text-right text-xs text-secondary tabular-nums">{value}</span>
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/** 漫画设置: how pages are laid out and turned. Changes apply at once. */
export function ComicSettingsSheet({
  preferences,
  keepScreenOn,
  volumeKeys,
  onChange,
  onKeepScreenOn,
  onVolumeKeys,
  onClose,
}: {
  preferences: ComicPreferences;
  keepScreenOn: boolean;
  volumeKeys: boolean;
  onChange: (change: Partial<ComicPreferences>) => void;
  onKeepScreenOn: (on: boolean) => void;
  onVolumeKeys: (on: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <SheetContent style={{ maxHeight: "calc(100dvh - 5rem)" }}>
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("comic.settings")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 overflow-y-auto pb-2">
          <Choices
            name="comic.mode"
            value={preferences.mode}
            options={["scroll", "paged", "double"] as const}
            onChange={(mode) => onChange({ mode })}
            note={preferences.mode === "double" ? t("comic.mode.note") : undefined}
          />
          {preferences.mode !== "scroll" && (
            <>
              <Choices
                name="comic.direction"
                value={preferences.direction}
                options={["left_to_right", "right_to_left"] as const}
                onChange={(direction) => onChange({ direction })}
              />
              <Choices
                name="comic.fit"
                value={preferences.fit}
                options={["width", "height", "screen"] as const}
                onChange={(fit) => onChange({ fit })}
              />
            </>
          )}
          {preferences.mode === "scroll" && (
            <Slider
              label={t("comic.gap")}
              value={preferences.gap}
              min={0}
              max={32}
              onChange={(gap) => onChange({ gap })}
            />
          )}
          <Slider
            label={t("comic.preload")}
            value={preferences.preload}
            min={1}
            max={20}
            onChange={(preload) => onChange({ preload })}
          />
          <Choices
            name="comic.background"
            value={preferences.background}
            options={["theme", "black", "white"] as const}
            onChange={(background) => onChange({ background })}
          />
          <Toggle
            label={t("comic.pageNumber")}
            checked={preferences.pageNumber}
            onChange={(pageNumber) => onChange({ pageNumber })}
          />
          <Toggle
            label={t("comic.keepScreenOn")}
            checked={keepScreenOn}
            onChange={onKeepScreenOn}
          />
          <Toggle label={t("comic.volumeKeys")} checked={volumeKeys} onChange={onVolumeKeys} />
        </div>
      </SheetContent>
    </Dialog>
  );
}
