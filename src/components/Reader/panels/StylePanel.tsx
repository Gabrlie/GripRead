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
import { Button } from "../../ui/button";
import { Icon } from "../../ui/Icon";
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

interface StylePanelProps {
  /** True while a view needs the page unobstructed, such as margins. */
  onPreview?: (previewing: boolean) => void;
  preferences: ReaderPreferences | null;
  night: boolean;
  onChange: (patch: Partial<ReaderPreferences>) => void;
  fonts: Pick<SettingsService, "pickAndImportFont" | "listFonts" | "deleteFont">;
  onClose: () => void;
}

type View = "main" | "text" | "margins" | "info" | "title" | "more" | { preset: number };

const EFFECTS = [
  ["cover", "覆盖"],
  ["slide", "平移"],
  ["curl", "仿真"],
  ["fade", "淡入"],
  ["instant", "无"],
] as const;

const SLOTS: [InfoSlot, string][] = [
  ["none", "无"],
  ["time", "时间"],
  ["battery", "电量"],
  ["chapter_title", "章节名"],
  ["book_title", "书名"],
  ["chapter_progress", "章节进度"],
  ["book_progress", "全书进度"],
];

const TAP_ACTIONS: [TapAction, string][] = [
  ["menu", "菜单"],
  ["next", "下一页"],
  ["previous", "上一页"],
  ["next-chapter", "下一章"],
  ["previous-chapter", "上一章"],
  ["contents", "目录"],
  ["search", "搜索"],
  ["bookmark", "书签"],
  ["none", "无"],
];

const ZONE_NAMES = ["左上", "中上", "右上", "左中", "中间", "右中", "左下", "中下", "右下"];

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
  preferences,
  night,
  onChange,
  fonts,
  onClose,
  onPreview,
}: StylePanelProps) {
  const [view, setView] = useState<View>("main");
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
      ? "编辑样式"
      : {
          main: "界面",
          text: "文字",
          margins: "边距",
          info: "页眉页脚",
          title: "标题",
          more: "更多设置",
        }[view];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <SheetContent style={{ maxHeight: "calc(100dvh - 5rem)" }}>
        <DialogHeader className="flex-row items-center gap-2 space-y-0">
          {view !== "main" && (
            <Button
              aria-label="返回界面设置"
              variant="ghost"
              size="icon"
              className="h-7 w-7 -ml-1"
              onClick={() => setView("main")}
            >
              <Icon name="chevron_left" size={18} />
            </Button>
          )}
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            调整会立即预览，并保留当前阅读位置。
          </DialogDescription>
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
                ["header", "页眉"],
                ["footer", "页脚"],
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
            <Section title="章节标题">
              <Choice
                label="标题位置"
                value={style.titleMode}
                options={[
                  ["left", "居左"],
                  ["center", "居中"],
                  ["hidden", "隐藏"],
                ]}
                onChange={(titleMode) => setStyle({ titleMode })}
              />
            </Section>
            <Range
              label="标题字号"
              min={1}
              max={2}
              step={0.05}
              value={style.titleScale}
              format={(value) => `${value.toFixed(2)}×`}
              onChange={(titleScale) => setStyle({ titleScale })}
            />
          </div>
        )}
        {view === "more" && <MoreView style={style} setStyle={setStyle} />}
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
          aria-label="减小字号"
          variant="outline"
          size="sm"
          className="h-8 w-10 text-xs"
          onClick={() => onChange({ fontSize: Math.max(12, preferences.fontSize - 1) })}
        >
          A-
        </Button>
        <input
          aria-label="字号"
          type="range"
          min={12}
          max={40}
          step={1}
          value={preferences.fontSize}
          onChange={(event) => onChange({ fontSize: Number(event.target.value) })}
          className="flex-1 accent-primary"
        />
        <Button
          aria-label="增大字号"
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
            ["text", "文字", "format_size"],
            ["margins", "边距", "space_bar"],
            ["info", "页眉页脚", "info"],
            ["title", "标题", "toc_rule"],
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
      <Section title="翻页动画">
        <Choice
          label="翻页动画"
          options={EFFECTS}
          value={preferences.pageTurnEffect}
          disabled={scroll}
          onChange={(pageTurnEffect) => onChange({ pageTurnEffect })}
        />
      </Section>
      <Section title="阅读方式">
        <Choice
          label="阅读方式"
          options={[
            ["single", "单页"],
            ["double", "双页"],
            ["scroll", "滚动"],
          ]}
          value={preferences.readingMode}
          onChange={(readingMode) => onChange({ readingMode })}
        />
        {preferences.readingMode === "double" && (
          <p className="text-[11px] text-secondary">窄屏自动显示单页，展开后恢复双页。</p>
        )}
      </Section>
      <Section title={`背景样式（${night ? "夜间" : "日间"}，长按或点铅笔编辑）`}>
        <div className="flex gap-2.5 overflow-x-auto scrollbar-none py-2 -mx-1 px-2">
          {style.presets.map((preset, index) => (
            <div key={index} className="flex flex-col items-center gap-1 shrink-0">
              <button
                aria-label={`样式 ${preset.name}`}
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
                文
              </button>
              <button
                aria-label={`编辑 ${preset.name}`}
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
              aria-label="新建样式"
              className="h-11 w-11 shrink-0 rounded-full border border-dashed border-surface-variant flex items-center justify-center text-secondary"
              onClick={() => {
                const copy: StylePreset = { ...style.presets[style.selected], name: "自定义" };
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
        更多设置
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
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fonts.listFonts().then(
      (list) => !cancelled && setAssets(list),
      (error: unknown) => !cancelled && setMessage(String(error)),
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
      <Section title="字体">
        <div role="radiogroup" aria-label="字体" className="space-y-1.5">
          {fontButton(
            !style.fontAssetId && preferences.fontFamily === "serif",
            "思源宋体（内置）",
            () => choose("serif"),
          )}
          {fontButton(!style.fontAssetId && preferences.fontFamily === "sans", "系统黑体", () =>
            choose("sans"),
          )}
          {assets?.map((asset) =>
            fontButton(
              style.fontAssetId === asset.id,
              asset.name,
              () => choose({ asset: asset.id }),
              <Button
                aria-label={`删除字体 ${asset.name}`}
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-secondary"
                onClick={() =>
                  fonts.deleteFont(asset.id).then(
                    () => {
                      setAssets((list) => list?.filter((item) => item.id !== asset.id) ?? null);
                      if (style.fontAssetId === asset.id) setStyle({ fontAssetId: null });
                    },
                    (error: unknown) => setMessage(String(error)),
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
                setMessage(`已导入 ${asset.name}`);
              },
              (error: unknown) => setMessage(String(error)),
            )
          }
        >
          <Icon name="add" size={14} />
          导入字体（TTF/OTF/WOFF）
        </Button>
        {message && <p className="text-[11px] text-secondary">{message}</p>}
      </Section>
      <Range
        label="字重"
        min={100}
        max={900}
        step={100}
        value={style.fontWeight}
        format={(value) => `${value}`}
        onChange={(fontWeight) => setStyle({ fontWeight })}
      />
      <Range
        label="字距"
        min={-0.1}
        max={0.5}
        step={0.01}
        value={style.letterSpacing}
        format={(value) => value.toFixed(2)}
        onChange={(letterSpacing) => setStyle({ letterSpacing })}
      />
      <Range
        label="行距"
        min={1}
        max={3.5}
        step={0.1}
        value={preferences.lineHeight}
        format={(value) => value.toFixed(1)}
        onChange={(lineHeight) => onChange({ lineHeight })}
      />
      <Range
        label="段距"
        min={0}
        max={3}
        step={0.1}
        value={style.paragraphSpacing}
        format={(value) => value.toFixed(1)}
        onChange={(paragraphSpacing) => setStyle({ paragraphSpacing })}
      />
      <Range
        label="缩进"
        min={0}
        max={4}
        step={1}
        value={style.indent}
        format={(value) => `${value} 字`}
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
          aria-label={`显示${label}`}
          checked={bar.visible}
          onCheckedChange={(visible) => onChange({ ...bar, visible })}
        />
      </label>
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ["left", "左"],
            ["middle", "中"],
            ["right", "右"],
          ] as const
        ).map(([position, name]) => (
          <select
            key={position}
            aria-label={`${label}${name}`}
            className={selectClass}
            disabled={!bar.visible}
            value={bar[position]}
            onChange={(event) => onChange({ ...bar, [position]: event.target.value as InfoSlot })}
          >
            {SLOTS.map(([slot, text]) => (
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
}: {
  style: ReadingStyle;
  setStyle: (patch: Partial<ReadingStyle>) => void;
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
      {toggle("屏幕常亮", "阅读时不自动熄屏", style.keepScreenOn, (keepScreenOn) =>
        setStyle({ keepScreenOn }),
      )}
      {toggle(
        "隐藏状态栏",
        "阅读时隐藏系统状态栏和导航栏，打开菜单时显示",
        style.hideSystemBars,
        (hideSystemBars) => setStyle({ hideSystemBars }),
      )}
      {toggle("音量键翻页", "音量减下一页，音量加上一页", style.volumeKeys, (volumeKeys) =>
        setStyle({ volumeKeys }),
      )}
      <Section title="点击区域">
        <div className="grid grid-cols-3 gap-1.5">
          {style.tapZones.map((action, index) => (
            <label
              key={index}
              className="flex flex-col gap-1 rounded-lg bg-surface-container px-2 py-1.5 text-[10px] text-secondary"
            >
              {ZONE_NAMES[index]}
              <select
                aria-label={`${ZONE_NAMES[index]}点击`}
                className="bg-transparent text-xs text-on-surface outline-none"
                value={action}
                onChange={(event) => {
                  const tapZones = [...style.tapZones];
                  tapZones[index] = event.target.value as TapAction;
                  setStyle({ tapZones });
                }}
              >
                {TAP_ACTIONS.map(([value, text]) => (
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
          恢复默认
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
  const preset = style.presets[index];
  if (!preset) return null;
  const update = (patch: Partial<StylePreset>) =>
    setStyle({
      presets: style.presets.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  const color = (label: string, key: keyof Omit<StylePreset, "name">) => (
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
          日间预览
        </span>
        <span
          className="rounded-lg py-3"
          style={{ background: preset.nightBackground, color: preset.nightText }}
        >
          夜间预览
        </span>
      </div>
      <label className="block space-y-1 text-xs text-secondary">
        名称
        <Input
          value={preset.name}
          maxLength={24}
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      {color("日间背景", "background")}
      {color("日间文字", "text")}
      {color("夜间背景", "nightBackground")}
      {color("夜间文字", "nightText")}
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
          删除样式
        </Button>
        <Button size="sm" disabled={!preset.name.trim()} onClick={onDone}>
          完成
        </Button>
      </div>
    </div>
  );
}

const SIDES = [
  ["top", "上"],
  ["bottom", "下"],
  ["left", "左"],
  ["right", "右"],
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
          <DialogTitle className="text-sm">边距</DialogTitle>
          <DialogDescription className="sr-only">
            调整时页面会实时显示效果，单位为像素。
          </DialogDescription>
        </DialogHeader>
        <Choice
          label="边距区域"
          value={area}
          options={[
            ["margins", "正文"],
            ["headerMargins", "页眉"],
            ["footerMargins", "页脚"],
          ]}
          onChange={setArea}
        />
        <div className="space-y-1.5">
          {SIDES.map(([side, label]) => (
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
            显示分隔线
            <Switch
              aria-label={area === "headerMargins" ? "显示页眉分隔线" : "显示页脚分隔线"}
              checked={style[line]}
              onCheckedChange={(value) => setStyle({ [line]: value })}
            />
          </label>
        )}
      </DialogContent>
    </Dialog>
  );
}
