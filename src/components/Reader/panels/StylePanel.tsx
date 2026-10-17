import { useEffect, useState, type ReactNode } from "react";
import type {
  InfoBar,
  InfoSlot,
  ReaderAsset,
  ReaderPreferences,
  ReadingStyle,
  StylePreset,
  TapAction,
} from "../../../types/generated";
import type { SettingsService } from "../../../services/contracts";
import { useRuntime } from "../../../application/runtime";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/Icon";
import { toast } from "../../ui/toast";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  SheetContent,
} from "../../ui/dialog";
import { t } from "../../../i18n";
import { describeError } from "../../Cloud/format";

interface StylePanelProps {
  /** The view shown first; the bottom bar's 设置 tool opens 更多设置. */
  initialView?: "main" | "more";
  /** True while a view needs the page unobstructed, such as margins. */
  onPreview?: (previewing: boolean) => void;
  preferences: ReaderPreferences | null;
  night: boolean;
  onChange: (patch: Partial<ReaderPreferences>) => void;
  fonts: Pick<SettingsService, "pickAndImportFont" | "listFonts" | "deleteFont">;
  onClose: () => void;
}

type View = "main" | "text" | "margins" | "info" | "title" | "more" | { preset: number };

const effects = () =>
  [
    ["cover", t("style.effect.cover")],
    ["slide", t("style.effect.slide")],
    ["curl", t("style.effect.curl")],
    ["fade", t("style.effect.fade")],
    ["instant", t("common.none")],
  ] as const;

const slots = (): [InfoSlot, string][] => [
  ["none", t("common.none")],
  ["time", t("style.slot.time")],
  ["battery", t("style.slot.battery")],
  ["chapter_title", t("style.slot.chapterTitle")],
  ["book_title", t("style.slot.bookTitle")],
  ["chapter_progress", t("style.slot.chapterProgress")],
  ["book_progress", t("style.slot.bookProgress")],
];

const tapActions = (): [TapAction, string][] => [
  ["menu", t("style.tap.menu")],
  ["next", t("style.tap.next")],
  ["previous", t("style.tap.previous")],
  ["next-chapter", t("style.tap.nextChapter")],
  ["previous-chapter", t("style.tap.previousChapter")],
  ["contents", t("detail.contents")],
  ["search", t("header.search")],
  ["bookmark", t("style.tap.bookmark")],
  ["none", t("common.none")],
];

const zoneNames = () => [
  t("style.zone.topLeft"),
  t("style.zone.top"),
  t("style.zone.topRight"),
  t("style.zone.left"),
  t("style.zone.centre"),
  t("style.zone.right"),
  t("style.zone.bottomLeft"),
  t("style.zone.bottom"),
  t("style.zone.bottomRight"),
];

const selectClass =
  "rounded-lg border border-surface-variant bg-surface-container px-2 py-1.5 text-xs min-w-0";

function Range({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-xs">
      <span className="w-14 shrink-0 text-secondary">{label}</span>
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="flex-1 accent-primary"
      />
      <output className="w-12 shrink-0 text-right tabular-nums">{format(value)}</output>
    </label>
  );
}

function Choice<T extends string>({
  options,
  value,
  onChange,
  disabled,
  label,
}: {
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map(([option, text]) => (
        <button
          key={option}
          role="radio"
          aria-checked={value === option}
          disabled={disabled}
          className={`h-8 rounded-lg text-xs border transition-colors disabled:opacity-40 ${value === option ? "bg-primary text-on-primary border-primary" : "border-surface-variant text-on-surface hover:bg-surface-container"}`}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-secondary font-medium">{title}</p>
      {children}
    </div>
  );
}

/**
 * Legado's 界面 (ReadStyleDialog): font size, page animation, reading mode,
 * and colour presets, with sub-views for text, margins, header and footer,
 * titles, preset editing, and more settings. Changes preview immediately.
 */
export function StylePanel({
  initialView = "main",
  preferences,
  night,
  onChange,
  fonts,
  onClose,
  onPreview,
}: StylePanelProps) {
  const [view, setView] = useState<View>(initialView);
  useEffect(() => {
    onPreview?.(view === "margins");
    return () => onPreview?.(false);
  }, [view, onPreview]);
  if (!preferences) return null;
  const style = preferences.style;
  const setStyle = (patch: Partial<ReadingStyle>) => onChange({ style: { ...style, ...patch } });
  if (view === "margins")
    return <MarginsDialog style={style} setStyle={setStyle} onBack={() => setView("main")} />;
  const title =
    typeof view === "object"
      ? t("style.editPreset")
      : {
          main: t("style.main"),
          text: t("style.text"),
          margins: t("style.margins"),
          info: t("style.info"),
          title: t("style.title"),
          more: t("style.more"),
        }[view];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <SheetContent style={{ maxHeight: "calc(100dvh - 5rem)" }}>
        <DialogHeader className="flex-row items-center gap-2 space-y-0">
          {view !== "main" && (
            <Button
              aria-label={t("style.back")}
              variant="ghost"
              size="icon"
              className="h-7 w-7 -ml-1"
              onClick={() => setView("main")}
            >
              <Icon name="chevron_left" size={18} />
            </Button>
          )}
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="sr-only">{t("style.note")}</DialogDescription>
        </DialogHeader>
        {view === "main" && (
          <MainView
            preferences={preferences}
            night={night}
            onChange={onChange}
            setStyle={setStyle}
            onOpen={setView}
          />
        )}
        {view === "text" && (
          <TextView
            preferences={preferences}
            onChange={onChange}
            setStyle={setStyle}
            fonts={fonts}
          />
        )}
        {view === "info" && (
          <div className="space-y-4">
            {(
              [
                ["header", t("style.header")],
                ["footer", t("style.footer")],
              ] as const
            ).map(([position, label]) => (
              <InfoEditor
                key={position}
                label={label}
                bar={style[position]}
                onChange={(bar) => setStyle({ [position]: bar })}
              />
            ))}
          </div>
        )}
        {view === "title" && (
          <div className="space-y-3">
            <Section title={t("style.chapterTitles")}>
              <Choice
                label={t("style.titlePosition")}
                value={style.titleMode}
                options={[
                  ["left", t("style.align.left")],
                  ["center", t("style.align.centre")],
                  ["hidden", t("style.align.hidden")],
                ]}
                onChange={(titleMode) => setStyle({ titleMode })}
              />
            </Section>
            <Range
              label={t("style.titleSize")}
              min={1}
              max={2}
              step={0.05}
              value={style.titleScale}
              format={(value) => `${value.toFixed(2)}×`}
              onChange={(titleScale) => setStyle({ titleScale })}
            />
          </div>
        )}
        {view === "more" && (
          <MoreView
            style={style}
            setStyle={setStyle}
            preDownload={preferences.preDownloadChapters ?? 10}
            onPreDownload={(preDownloadChapters) => onChange({ preDownloadChapters })}
          />
        )}
        {typeof view === "object" && (
          <PresetEditor
            style={style}
            index={view.preset}
            setStyle={setStyle}
            onDone={() => setView("main")}
          />
        )}
      </SheetContent>
    </Dialog>
  );
}

function MainView({
  preferences,
  night,
  onChange,
  setStyle,
  onOpen,
}: {
  preferences: ReaderPreferences;
  night: boolean;
  onChange: (patch: Partial<ReaderPreferences>) => void;
  setStyle: (patch: Partial<ReadingStyle>) => void;
  onOpen: (view: View) => void;
}) {
  const style = preferences.style;
  const scroll = preferences.readingMode === "scroll";
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          aria-label={t("style.smaller")}
          variant="outline"
          size="sm"
          className="h-8 w-10 text-xs"
          onClick={() => onChange({ fontSize: Math.max(12, preferences.fontSize - 1) })}
        >
          A-
        </Button>
        <input
          aria-label={t("style.fontSize")}
          type="range"
          min={12}
          max={40}
          step={1}
          value={preferences.fontSize}
          onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
          className="flex-1 accent-primary"
        />
        <Button
          aria-label={t("style.larger")}
          variant="outline"
          size="sm"
          className="h-8 w-10 text-xs"
          onClick={() => onChange({ fontSize: Math.min(40, preferences.fontSize + 1) })}
        >
          A+
        </Button>
        <span className="w-8 text-right text-xs tabular-nums">{preferences.fontSize}</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {(
          [
            ["text", t("style.text"), "format_size"],
            ["margins", t("style.margins"), "space_bar"],
            ["info", t("style.info"), "info"],
            ["title", t("style.title"), "toc_rule"],
          ] as const
        ).map(([target, label, icon]) => (
          <button
            key={target}
            className="flex flex-col items-center gap-1 rounded-xl py-2 text-[11px] text-secondary hover:bg-surface-container"
            onClick={() => onOpen(target)}
          >
            <Icon name={icon} size={18} />
            {label}
          </button>
        ))}
      </div>
      <Section title={t("style.effect")}>
        <Choice
          label={t("style.effect")}
          options={effects()}
          value={preferences.pageTurnEffect}
          disabled={scroll}
          onChange={(pageTurnEffect) => onChange({ pageTurnEffect })}
        />
      </Section>
      <Section title={t("style.mode")}>
        <Choice
          label={t("style.mode")}
          options={[
            ["single", t("style.mode.single")],
            ["double", t("style.mode.double")],
            ["scroll", t("style.mode.scroll")],
          ]}
          value={preferences.readingMode}
          onChange={(readingMode) => onChange({ readingMode })}
        />
        {preferences.readingMode === "double" && (
          <p className="text-[11px] text-secondary">{t("style.doubleNote")}</p>
        )}
      </Section>
      <Section title={t("style.presets", { time: night ? t("style.night") : t("style.day") })}>
        <div className="flex gap-2.5 overflow-x-auto scrollbar-none py-2 -mx-1 px-2">
          {style.presets.map((preset, index) => (
            <div key={index} className="flex flex-col items-center gap-1 shrink-0">
              <button
                aria-label={t("style.preset", { name: preset.name })}
                aria-pressed={style.selected === index}
                className={`h-11 w-11 rounded-full border text-sm font-medium flex items-center justify-center transition-shadow ${style.selected === index ? "ring-2 ring-primary ring-offset-2 ring-offset-surface" : "border-black/10"}`}
                style={{
                  background: night ? preset.nightBackground : preset.background,
                  color: night ? preset.nightText : preset.text,
                }}
                onClick={() => setStyle({ selected: index })}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onOpen({ preset: index });
                }}
              >
                {t("style.sample")}
              </button>
              <button
                aria-label={t("style.editNamed", { name: preset.name })}
                className="text-[10px] text-secondary flex items-center gap-0.5"
                onClick={() => onOpen({ preset: index })}
              >
                {preset.name}
                <Icon name="edit" size={10} />
              </button>
            </div>
          ))}
          {style.presets.length < 32 && (
            <button
              aria-label={t("style.newPreset")}
              className="h-11 w-11 shrink-0 rounded-full border border-dashed border-surface-variant flex items-center justify-center text-secondary"
              onClick={() => {
                const copy: StylePreset = {
                  ...style.presets[style.selected],
                  name: t("style.custom"),
                };
                setStyle({ presets: [...style.presets, copy], selected: style.presets.length });
                onOpen({ preset: style.presets.length });
              }}
            >
              <Icon name="add" size={18} />
            </button>
          )}
        </div>
      </Section>
      <Button variant="outline" className="w-full h-9 text-xs" onClick={() => onOpen("more")}>
        <Icon name="settings" size={14} />
        {t("style.more")}
      </Button>
    </div>
  );
}

function TextView({
  preferences,
  onChange,
  setStyle,
  fonts,
}: {
  preferences: ReaderPreferences;
  onChange: (patch: Partial<ReaderPreferences>) => void;
  setStyle: (patch: Partial<ReadingStyle>) => void;
  fonts: StylePanelProps["fonts"];
}) {
  const style = preferences.style;
  const [assets, setAssets] = useState<ReaderAsset[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fonts.listFonts().then(
      (list) => !cancelled && setAssets(list),
      (error: unknown) => !cancelled && toast({ text: describeError(error), error: true }),
    );
    return () => {
      cancelled = true;
    };
  }, [fonts]);
  const choose = (family: "serif" | "sans" | { asset: string }) =>
    typeof family === "string"
      ? onChange({ fontFamily: family, style: { ...style, fontAssetId: null } })
      : setStyle({ fontAssetId: family.asset });
  const fontButton = (selected: boolean, label: string, onClick: () => void, extra?: ReactNode) => (
    <div className="flex items-center gap-1">
      <button
        role="radio"
        aria-checked={selected}
        className={`flex-1 min-w-0 text-left truncate rounded-lg px-3 py-2 text-xs border ${selected ? "border-primary text-primary bg-surface-container" : "border-surface-variant"}`}
        onClick={onClick}
      >
        {label}
      </button>
      {extra}
    </div>
  );
  return (
    <div className="space-y-4">
      <Section title={t("style.font")}>
        <div role="radiogroup" aria-label={t("style.font")} className="space-y-1.5">
          {fontButton(
            !style.fontAssetId && preferences.fontFamily === "serif",
            t("style.font.serif"),
            () => choose("serif"),
          )}
          {fontButton(
            !style.fontAssetId && preferences.fontFamily === "sans",
            t("style.font.sans"),
            () => choose("sans"),
          )}
          {assets?.map((asset) =>
            fontButton(
              style.fontAssetId === asset.id,
              asset.name,
              () => choose({ asset: asset.id }),
              <Button
                aria-label={t("style.font.delete", { name: asset.name })}
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-secondary"
                onClick={() =>
                  fonts.deleteFont(asset.id).then(
                    () => {
                      setAssets((list) => list?.filter((item) => item.id !== asset.id) ?? null);
                      if (style.fontAssetId === asset.id) setStyle({ fontAssetId: null });
                    },
                    (error: unknown) => toast({ text: describeError(error), error: true }),
                  )
                }
              >
                <Icon name="delete" size={14} />
              </Button>,
            ),
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={() =>
            fonts.pickAndImportFont().then(
              (asset) => {
                if (!asset) return;
                setAssets((list) => [...(list ?? []), asset]);
                setStyle({ fontAssetId: asset.id });
                toast(t("style.font.imported", { name: asset.name }));
              },
              (error: unknown) => toast({ text: describeError(error), error: true }),
            )
          }
        >
          <Icon name="add" size={14} />
          {t("style.font.import")}
        </Button>
      </Section>
      <Range
        label={t("style.weight")}
        min={100}
        max={900}
        step={100}
        value={style.fontWeight}
        format={(value) => `${value}`}
        onChange={(fontWeight) => setStyle({ fontWeight })}
      />
      <Range
        label={t("style.letterSpacing")}
        min={-0.1}
        max={0.5}
        step={0.01}
        value={style.letterSpacing}
        format={(value) => value.toFixed(2)}
        onChange={(letterSpacing) => setStyle({ letterSpacing })}
      />
      <Range
        label={t("style.lineSpacing")}
        min={1}
        max={3.5}
        step={0.1}
        value={preferences.lineHeight}
        format={(value) => value.toFixed(1)}
        onChange={(lineHeight) => onChange({ lineHeight })}
      />
      <Range
        label={t("style.paragraphSpacing")}
        min={0}
        max={3}
        step={0.1}
        value={style.paragraphSpacing}
        format={(value) => value.toFixed(1)}
        onChange={(paragraphSpacing) => setStyle({ paragraphSpacing })}
      />
      <Range
        label={t("style.indent")}
        min={0}
        max={4}
        step={1}
        value={style.indent}
        format={(value) => t("style.indentValue", { value })}
        onChange={(indent) => setStyle({ indent })}
      />
    </div>
  );
}

function InfoEditor({
  label,
  bar,
  onChange,
}: {
  label: string;
  bar: InfoBar;
  onChange: (bar: InfoBar) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <Switch
          aria-label={t("style.showBar", { bar: label })}
          checked={bar.visible}
          onCheckedChange={(visible) => onChange({ ...bar, visible })}
        />
      </label>
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ["left", t("style.side.left")],
            ["middle", t("style.side.middle")],
            ["right", t("style.side.right")],
          ] as const
        ).map(([position, name]) => (
          <select
            key={position}
            aria-label={t("style.barSlot", { bar: label, position: name })}
            className={selectClass}
            disabled={!bar.visible}
            value={bar[position]}
            onChange={(event) => onChange({ ...bar, [position]: event.target.value as InfoSlot })}
          >
            {slots().map(([slot, text]) => (
              <option key={slot} value={slot}>
                {text}
              </option>
            ))}
          </select>
        ))}
      </div>
    </div>
  );
}

function MoreView({
  style,
  setStyle,
  preDownload,
  onPreDownload,
}: {
  style: ReadingStyle;
  setStyle: (patch: Partial<ReadingStyle>) => void;
  /** Legado's 预下载章节数, for online books. */
  preDownload: number;
  onPreDownload: (chapters: number) => void;
}) {
  const toggle = (
    label: string,
    note: string,
    value: boolean,
    change: (value: boolean) => void,
  ) => (
    <label className="flex items-center justify-between gap-3 text-xs">
      <span>
        {label}
        <span className="block text-[11px] text-secondary">{note}</span>
      </span>
      <Switch aria-label={label} checked={value} onCheckedChange={change} />
    </label>
  );
  return (
    <div className="space-y-4">
      {toggle(t("style.keepOn"), t("style.keepOn.note"), style.keepScreenOn, (keepScreenOn) =>
        setStyle({ keepScreenOn }),
      )}
      {toggle(
        t("style.hideBars"),
        t("style.hideBars.note"),
        style.hideSystemBars,
        (hideSystemBars) => setStyle({ hideSystemBars }),
      )}
      {toggle(t("style.volumeKeys"), t("style.volumeKeys.note"), style.volumeKeys, (volumeKeys) =>
        setStyle({ volumeKeys }),
      )}
      {toggle(
        t("style.menuTheme"),
        t("style.menuTheme.note"),
        style.menuFollowsPage,
        (menuFollowsPage) => setStyle({ menuFollowsPage }),
      )}
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>
          {t("style.preDownload")}
          <span className="block text-[11px] text-secondary">{t("downloads.books")}</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t("style.preDownload.less")}
            className="h-7 w-7 rounded-full border border-surface-variant"
            onClick={() => onPreDownload(Math.max(0, preDownload - 5))}
          >
            −
          </button>
          <span className="w-8 text-center tabular-nums" aria-label={t("style.preDownload")}>
            {preDownload}
          </span>
          <button
            type="button"
            aria-label={t("style.preDownload.more")}
            className="h-7 w-7 rounded-full border border-surface-variant"
            onClick={() => onPreDownload(Math.min(50, preDownload + 5))}
          >
            +
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>
          {t("style.orientation")}
          <span className="block text-[11px] text-secondary">{t("style.orientation.note")}</span>
        </span>
        <div role="radiogroup" aria-label={t("style.orientation")} className="flex gap-1">
          {(
            [
              ["auto", t("common.followSystem")],
              ["portrait", t("style.portrait")],
              ["landscape", t("style.landscape")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={style.orientation === value}
              onClick={() => setStyle({ orientation: value })}
              className={`h-7 px-2.5 rounded-full text-[11px] border ${style.orientation === value ? "bg-primary text-on-primary border-primary" : "border-surface-variant text-on-surface"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <Section title={t("style.tapZones")}>
        <div className="grid grid-cols-3 gap-1.5">
          {style.tapZones.map((action, index) => (
            <label
              key={index}
              className="flex flex-col gap-1 rounded-lg bg-surface-container px-2 py-1.5 text-[10px] text-secondary"
            >
              {zoneNames()[index]}
              <select
                aria-label={t("style.zoneTap", { zone: zoneNames()[index] })}
                className="bg-transparent text-xs text-on-surface outline-none"
                value={action}
                onChange={(event) => {
                  const tapZones = [...style.tapZones];
                  tapZones[index] = event.target.value as TapAction;
                  setStyle({ tapZones });
                }}
              >
                {tapActions().map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() =>
            setStyle({
              tapZones: [
                "previous",
                "previous",
                "next",
                "previous",
                "menu",
                "next",
                "previous",
                "next",
                "next",
              ],
            })
          }
        >
          {t("detail.resetCover")}
        </Button>
      </Section>
    </div>
  );
}

function PresetEditor({
  style,
  index,
  setStyle,
  onDone,
}: {
  style: ReadingStyle;
  index: number;
  setStyle: (patch: Partial<ReadingStyle>) => void;
  onDone: () => void;
}) {
  const runtime = useRuntime();
  const [imageError, setImageError] = useState<string | null>(null);
  const preset = style.presets[index];
  if (!preset) return null;
  /** Legado's 背景图片: an image replaces the colour behind the text. */
  const image = (label: string, key: "backgroundImage" | "nightBackgroundImage") => (
    <div className="flex items-center justify-between text-xs">
      {label}
      <span className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
          onClick={() =>
            void runtime.services.settings.pickBackgroundImage().then(
              (asset) => {
                setImageError(null);
                if (asset) update({ [key]: asset.id });
              },
              (failure: unknown) => setImageError(describeError(failure)),
            )
          }
        >
          {preset[key] ? t("style.image.change") : t("style.image.choose")}
        </Button>
        {preset[key] && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => update({ [key]: null })}
          >
            {t("style.image.remove")}
          </Button>
        )}
      </span>
    </div>
  );
  const update = (patch: Partial<StylePreset>) =>
    setStyle({
      presets: style.presets.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  const color = (label: string, key: "background" | "text" | "nightBackground" | "nightText") => (
    <label className="flex items-center justify-between text-xs">
      {label}
      <input
        aria-label={label}
        type="color"
        value={preset[key].slice(0, 7)}
        onChange={(event) => update({ [key]: event.target.value })}
        className="h-8 w-14 rounded border border-surface-variant bg-transparent"
      />
    </label>
  );
  return (
    <div className="space-y-3">
      <div className="rounded-xl p-3 text-sm grid grid-cols-2 gap-2 text-center" aria-hidden="true">
        <span
          className="rounded-lg py-3"
          style={{ background: preset.background, color: preset.text }}
        >
          {t("style.dayPreview")}
        </span>
        <span
          className="rounded-lg py-3"
          style={{ background: preset.nightBackground, color: preset.nightText }}
        >
          {t("style.nightPreview")}
        </span>
      </div>
      <label className="block space-y-1 text-xs text-secondary">
        {t("style.name")}
        <Input
          value={preset.name}
          maxLength={24}
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      {color(t("style.dayBackground"), "background")}
      {image(t("style.dayImage"), "backgroundImage")}
      {color(t("style.dayText"), "text")}
      {color(t("style.nightBackground"), "nightBackground")}
      {image(t("style.nightImage"), "nightBackgroundImage")}
      {color(t("style.nightText"), "nightText")}
      {imageError && (
        <p role="alert" className="text-xs text-error break-words">
          {imageError}
        </p>
      )}
      <div className="flex justify-between gap-2 pt-1">
        <Button
          variant="outline"
          size="sm"
          disabled={style.presets.length <= 1}
          onClick={() => {
            const presets = style.presets.filter((_, position) => position !== index);
            setStyle({ presets, selected: Math.min(style.selected, presets.length - 1) });
            onDone();
          }}
        >
          {t("style.deletePreset")}
        </Button>
        <Button size="sm" disabled={!preset.name.trim()} onClick={onDone}>
          {t("common.done")}
        </Button>
      </div>
    </div>
  );
}

const sides = () =>
  [
    ["top", t("style.side.top")],
    ["bottom", t("style.side.bottom")],
    ["left", t("style.side.left")],
    ["right", t("style.side.right")],
  ] as const;

/**
 * Legado's PaddingConfigDialog as a small centred dialog over a live page:
 * no blur, the reading menu hidden, and one area (body, header, or footer)
 * at a time with its divider line.
 */
function MarginsDialog({
  style,
  setStyle,
  onBack,
}: {
  style: ReadingStyle;
  setStyle: (patch: Partial<ReadingStyle>) => void;
  onBack: () => void;
}) {
  const [area, setArea] = useState<"margins" | "headerMargins" | "footerMargins">("margins");
  const line =
    area === "headerMargins" ? "headerLine" : area === "footerMargins" ? "footerLine" : null;
  return (
    <Dialog open onOpenChange={(open) => !open && onBack()}>
      <DialogContent
        overlayClassName="bg-transparent backdrop-blur-none"
        className="grid-cols-1 bg-surface border border-surface-variant/50 rounded-2xl w-[min(18rem,calc(100%-2rem))] sm:max-w-xs p-3.5 gap-2.5 shadow-xl"
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{t("style.margins")}</DialogTitle>
          <DialogDescription className="sr-only">{t("style.margins.note")}</DialogDescription>
        </DialogHeader>
        <Choice
          label={t("style.margins.area")}
          value={area}
          options={[
            ["margins", t("style.margins.text")],
            ["headerMargins", t("style.header")],
            ["footerMargins", t("style.footer")],
          ]}
          onChange={setArea}
        />
        <div className="space-y-1.5">
          {sides().map(([side, label]) => (
            <Range
              key={side}
              label={label}
              min={0}
              max={area === "margins" ? 80 : 60}
              step={1}
              value={style[area][side]}
              format={(value) => `${value}`}
              onChange={(value) => setStyle({ [area]: { ...style[area], [side]: value } })}
            />
          ))}
        </div>
        {line && (
          <label className="flex items-center justify-between text-xs">
            {t("style.divider")}
            <Switch
              aria-label={
                area === "headerMargins" ? t("style.divider.header") : t("style.divider.footer")
              }
              checked={style[line]}
              onCheckedChange={(value) => setStyle({ [line]: value })}
            />
          </label>
        )}
      </DialogContent>
    </Dialog>
  );
}
