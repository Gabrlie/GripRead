import { useState } from "react";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import { refreshIntervals } from "./format";

/** Refresh intervals the core accepts: off, or between these minutes. */
export const MIN_REFRESH = 5;
export const MAX_REFRESH = 24 * 60;

export function Toggle({
  label,
  note,
  checked,
  onChange,
}: {
  label: string;
  note?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <span className="min-w-0">
        {label}
        {note && <span className="block text-[11px] text-secondary">{note}</span>}
      </span>
      <Switch aria-label={label} checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

/** A row of choices; `extra` adds one more button after them (自定义). */
export function Choice<T extends string | number | boolean | null>({
  label,
  note,
  options,
  value,
  onPick,
  extra,
}: {
  label: string;
  note?: string;
  options: [T, string][];
  value: T;
  onPick: (value: T) => void;
  extra?: { label: string; checked: boolean; onPick: () => void };
}) {
  const buttons = options.length + (extra ? 1 : 0);
  const button = (checked: boolean) =>
    `h-7 rounded-md text-[11px] truncate px-1 ${
      checked ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"
    }`;
  return (
    <div className="px-4 py-3 space-y-2">
      <span className="block text-sm">
        {label}
        {note && <span className="block text-[11px] text-secondary">{note}</span>}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid gap-1 bg-surface-container p-1 rounded-lg"
        style={{ gridTemplateColumns: `repeat(${buttons}, minmax(0, 1fr))` }}
      >
        {options.map(([option, text]) => (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={!extra?.checked && value === option}
            onClick={() => onPick(option)}
            className={button(!extra?.checked && value === option)}
          >
            {text}
          </button>
        ))}
        {extra && (
          <button
            type="button"
            role="radio"
            aria-checked={extra.checked}
            onClick={extra.onPick}
            className={button(extra.checked)}
          >
            {extra.label}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A feed's group: typed (with the known ones offered), or picked from the
 * groups as chips; "" is no group.
 */
export function GroupField({
  value,
  onChange,
  groups,
  id,
}: {
  value: string;
  onChange: (group: string) => void;
  groups: string[];
  /** Ties the input to its list of known groups. */
  id: string;
}) {
  const t = useT();
  const chosen = value.trim() || null;
  return (
    <>
      <Input
        aria-label={t("rss.group")}
        placeholder={t("rss.feed.noGroup")}
        list={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={id}>
        {groups.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {groups.length > 0 && (
        <span className="flex flex-wrap gap-1.5 pt-1">
          {[null, ...groups].map((name) => (
            <button
              key={name ?? ""}
              type="button"
              aria-pressed={chosen === name}
              onClick={() => onChange(name ?? "")}
              className={`h-7 px-2.5 rounded-full text-[11px] ${
                chosen === name
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container text-secondary"
              }`}
            >
              {name ?? t("rss.feed.noGroup")}
            </button>
          ))}
        </span>
      )}
    </>
  );
}

/** Asks for a refresh interval in minutes. */
function MinutesDialog({
  value,
  onSave,
  onClose,
}: {
  value: number | null;
  onSave: (minutes: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(value ? String(value) : "");
  const minutes = Number(text);
  const valid = Number.isInteger(minutes) && minutes >= MIN_REFRESH && minutes <= MAX_REFRESH;
  const bounds = { min: MIN_REFRESH, max: MAX_REFRESH };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-sm p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("rss.settings.customMinutes")}
          </DialogTitle>
          <DialogDescription>{t("rss.settings.customMinutes.note", bounds)}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) {
              toast({ text: t("rss.settings.customMinutes.invalid", bounds), error: true });
              return;
            }
            onSave(minutes);
            onClose();
          }}
        >
          <Input
            autoFocus
            inputMode="numeric"
            aria-label={t("rss.settings.customMinutes")}
            value={text}
            onChange={(event) => setText(event.target.value.replace(/\D/g, ""))}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!text}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A refresh interval: the usual ones, or any number of minutes (自定义).
 * With `follow`, `null` follows the global setting.
 */
export function IntervalChoice({
  label,
  note,
  value,
  onPick,
  follow,
}: {
  label: string;
  note?: string;
  value: number | null;
  onPick: (minutes: number | null) => void;
  follow?: boolean;
}) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const presets: [number | null, string][] = refreshIntervals(
    follow ? [30, 60, 180, 360] : [0, 30, 60, 180, 360],
  );
  const options = follow
    ? [[null, t("rss.settings.follow")] as [null, string], ...presets]
    : presets;
  const custom = !options.some(([option]) => option === value);
  return (
    <>
      <Choice
        label={label}
        note={note}
        options={options}
        value={value}
        onPick={onPick}
        extra={{
          label:
            custom && value
              ? t("rss.settings.minutes", { count: value })
              : t("rss.settings.custom"),
          checked: custom,
          onPick: () => setAsking(true),
        }}
      />
      {asking && <MinutesDialog value={value} onSave={onPick} onClose={() => setAsking(false)} />}
    </>
  );
}
