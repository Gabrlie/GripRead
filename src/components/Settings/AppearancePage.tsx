import { useState } from "react";
import { useOptionalImage, useRuntime, useSettings } from "../../application/runtime";
import { parseHex, stylePalette } from "../../application/theme-colors";
import { languageChoice, setLanguage, t, type LanguageChoice, type MessageKey } from "../../i18n";
import type { InterfaceStyle, ReaderPreferences } from "../../types/generated";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";
import {
  PINNED_MAX,
  choose,
  chosenStyle,
  pinnedChoices,
  styleChoices,
  type StyleChoice,
} from "./interface-styles";
import { describeError } from "../Cloud/format";

const HOME_TABS: ["bookshelf" | "discover" | "settings", MessageKey][] = [
  ["bookshelf", "nav.shelf"],
  ["discover", "nav.discover"],
  ["settings", "nav.settings"],
];

const LANGUAGES: [LanguageChoice, string][] = [
  ["system", ""],
  ["zh-CN", "简体中文"],
  ["en", "English"],
];

/**
 * 更多外观设置: the interface language and every 界面样式, built-in or made
 * here. A style made from a main colour derives the others unless they
 * are set; up to four styles are pinned to 外观.
 */
export function AppearancePage({ onClose }: { onClose: () => void }) {
  const { state, store } = useSettings();
  const value = state.value;
  const [language, setLanguageChoice] = useState(languageChoice());
  const [editing, setEditing] = useState<InterfaceStyle | null>(null);
  if (!value) return null;
  const all = styleChoices(value);
  const pinned = pinnedChoices(value).map((choice) => choice.id);
  const chosen = chosenStyle(value);

  const togglePin = (choice: StyleChoice) => {
    if (pinned.includes(choice.id)) {
      if (pinned.length === 1) return;
      store.set({ pinnedStyles: pinned.filter((id) => id !== choice.id) });
    } else if (pinned.length >= PINNED_MAX) {
      toast({ text: t("appearance.pinFull", { count: PINNED_MAX }), error: true });
    } else {
      store.set({ pinnedStyles: [...pinned, choice.id] });
    }
  };
  const saveStyle = (style: InterfaceStyle) => {
    const styles = value.customStyles ?? [];
    const exists = styles.some((item) => item.id === style.id);
    const patch: Partial<ReaderPreferences> = {
      customStyles: exists
        ? styles.map((item) => (item.id === style.id ? style : item))
        : [...styles, style],
      customStyle: style.id,
    };
    // A new style shows in 外观 while there is room.
    if (!exists && pinned.length < PINNED_MAX) patch.pinnedStyles = [...pinned, style.id];
    store.set(patch);
    setEditing(null);
  };
  const deleteStyle = (id: string) => {
    store.set({
      customStyles: (value.customStyles ?? []).filter((item) => item.id !== id),
      pinnedStyles: pinned.filter((item) => item !== id),
      customStyle: value.customStyle === id ? undefined : value.customStyle,
    });
    setEditing(null);
  };

  return (
    <FullPage label={t("appearance.title")} onClose={onClose}>
      <PageSection title={t("settings.language")}>
        <div className="p-4">
          <div
            role="radiogroup"
            aria-label={t("settings.language")}
            className="grid grid-cols-3 gap-1.5 bg-surface-container p-1 rounded-lg"
          >
            {LANGUAGES.map(([choice, label]) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={language === choice}
                onClick={() => {
                  setLanguage(choice);
                  setLanguageChoice(choice);
                }}
                className={`h-8 rounded-md text-xs ${language === choice ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
              >
                {label || t("common.followSystem")}
              </button>
            ))}
          </div>
        </div>
      </PageSection>

      <PageSection title={t("settings.interfaceStyle")}>
        <p className="px-4 pt-3 text-[11px] text-secondary">
          {t("appearance.pinNote", { count: PINNED_MAX })}
        </p>
        <ul role="radiogroup" aria-label={t("settings.interfaceStyle")} className="py-1">
          {all.map((choice) => {
            const selected = chosen === choice.id;
            const isPinned = pinned.includes(choice.id);
            return (
              <li key={choice.id} className="flex items-center gap-3 px-4 py-2 min-h-12">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => store.set(choose(choice))}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left"
                >
                  <StyleChip choice={choice} />
                  <span className="min-w-0 flex-1 truncate text-sm">{choice.name}</span>
                  {selected && (
                    <span className="shrink-0 rounded px-1.5 text-[10px] leading-4 bg-primary/10 text-primary">
                      {t("appearance.inUse")}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-pressed={isPinned}
                  aria-label={t("appearance.pin", { name: choice.name })}
                  onClick={() => togglePin(choice)}
                  className={`h-8 w-8 shrink-0 rounded-full inline-flex items-center justify-center ${isPinned ? "text-primary" : "text-secondary/50"}`}
                >
                  <Icon name="push_pin" size={15} fill={isPinned} />
                </button>
                <span className="h-8 w-8 shrink-0 inline-flex">
                  {choice.custom && (
                    <button
                      type="button"
                      aria-label={t("appearance.edit", { name: choice.name })}
                      onClick={() => setEditing(choice.custom!)}
                      className="h-8 w-8 rounded-full inline-flex items-center justify-center text-secondary"
                    >
                      <Icon name="edit" size={15} />
                    </button>
                  )}
                </span>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className="w-full flex items-center gap-3 px-4 py-2 min-h-12 text-sm text-primary"
              onClick={() =>
                setEditing({
                  id: `style-${Date.now().toString(36)}`,
                  name: t("appearance.newName"),
                  primary: "#4a6fa5",
                  paper: null,
                  text: null,
                  secondary: null,
                })
              }
            >
              <span className="h-8 w-8 rounded-lg border border-dashed border-current inline-flex items-center justify-center">
                <Icon name="add" size={15} />
              </span>
              {t("appearance.new")}
            </button>
          </li>
        </ul>
      </PageSection>

      <PageSection title={t("appearance.cover")}>
        <CoverImages value={value} onChange={(patch) => store.set(patch)} />
        <Toggle
          label={t("appearance.coverName")}
          checked={value.coverShowName ?? true}
          onChange={(coverShowName) => store.set({ coverShowName })}
        />
        <Toggle
          label={t("appearance.coverAuthor")}
          checked={value.coverShowAuthor ?? true}
          onChange={(coverShowAuthor) => store.set({ coverShowAuthor })}
        />
        <Toggle
          label={t("appearance.coverWifi")}
          note={t("appearance.coverWifi.note")}
          checked={value.coversWifiOnly ?? false}
          onChange={(coversWifiOnly) => store.set({ coversWifiOnly })}
        />
      </PageSection>

      <PageSection title={t("appearance.main")}>
        <div className="px-4 py-3 space-y-2 text-sm">
          <span>{t("appearance.home")}</span>
          <div
            role="radiogroup"
            aria-label={t("appearance.home")}
            className="grid grid-cols-3 gap-1.5 bg-surface-container p-1 rounded-lg"
          >
            {HOME_TABS.map(([tab, label]) => {
              const current = (value.homeTab ?? "bookshelf") === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  role="radio"
                  aria-checked={current}
                  onClick={() =>
                    store.set(
                      tab === "discover" ? { homeTab: tab, showDiscover: true } : { homeTab: tab },
                    )
                  }
                  className={`h-8 rounded-md text-xs ${current ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
                >
                  {t(label)}
                </button>
              );
            })}
          </div>
        </div>
        <Toggle
          label={t("appearance.showDiscover")}
          checked={value.showDiscover ?? true}
          onChange={(showDiscover) =>
            store.set(
              showDiscover || value.homeTab !== "discover"
                ? { showDiscover }
                : { showDiscover, homeTab: "bookshelf" },
            )
          }
        />
      </PageSection>

      <PageSection title={t("appearance.nav")}>
        <Toggle
          label={t("appearance.navLabels")}
          checked={value.navLabels ?? true}
          onChange={(navLabels) => store.set({ navLabels })}
        />
        <Toggle
          label={t("appearance.navAutohide")}
          note={t("appearance.navAutohide.note")}
          checked={value.navAutohide ?? false}
          onChange={(navAutohide) => store.set({ navAutohide })}
        />
      </PageSection>

      {editing && (
        <StyleEditor
          style={editing}
          existing={(value.customStyles ?? []).some((item) => item.id === editing.id)}
          onSave={saveStyle}
          onDelete={() => deleteStyle(editing.id)}
          onClose={() => setEditing(null)}
        />
      )}
    </FullPage>
  );
}

const OPTIONAL: ["paper" | "text" | "secondary", string][] = [
  ["paper", "appearance.paper"],
  ["text", "appearance.text"],
  ["secondary", "appearance.secondary"],
];

/** Makes or edits a 界面样式: the main colour, and the others or 自动. */
function StyleEditor({
  style,
  existing,
  onSave,
  onDelete,
  onClose,
}: {
  style: InterfaceStyle;
  existing: boolean;
  onSave: (style: InterfaceStyle) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(style);
  const day = stylePalette(draft, false);
  const night = stylePalette(draft, true);
  const valid = Boolean(parseHex(draft.primary)) && draft.name.trim().length > 0;
  const colour = (palette: Record<string, string>, name: string) => `rgb(${palette[name]})`;
  const row = (
    label: string,
    current: string | null,
    set: (value: string | null) => void,
    derived: string,
  ) => (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex-1 min-w-0 text-secondary truncate">{label}</span>
      <input
        type="color"
        aria-label={label}
        value={current ?? derived}
        onChange={(event) => set(event.target.value)}
        className="h-7 w-9 shrink-0 rounded border border-surface-variant bg-transparent"
      />
      <Input
        aria-label={`${label} #`}
        value={current ?? ""}
        placeholder={t("appearance.auto")}
        onChange={(event) => set(event.target.value.trim() || null)}
        className="h-7 w-24 shrink-0 text-xs font-mono"
      />
    </div>
  );
  const hex = (palette: Record<string, string>, name: string) =>
    `#${palette[name]
      .split(" ")
      .map((part) => Number(part).toString(16).padStart(2, "0"))
      .join("")}`;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[86dvh] overflow-y-auto p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {existing ? t("appearance.editTitle") : t("appearance.new")}
          </DialogTitle>
        </DialogHeader>
        <label className="block space-y-1 text-xs text-secondary">
          {t("appearance.name")}
          <Input
            aria-label={t("appearance.name")}
            value={draft.name}
            maxLength={40}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        {row(
          t("appearance.primary"),
          draft.primary,
          (primary) => setDraft({ ...draft, primary: primary ?? "" }),
          "#4a6fa5",
        )}
        <p className="text-[11px] text-secondary">{t("appearance.autoNote")}</p>
        {OPTIONAL.map(([key, label]) => {
          const name =
            key === "paper"
              ? "--color-surface-rgb"
              : key === "text"
                ? "--color-on-surface-rgb"
                : "--color-secondary-rgb";
          return (
            <div key={key}>
              {row(
                t(label as "appearance.paper"),
                draft[key] ?? null,
                (value) => setDraft({ ...draft, [key]: value }),
                hex(day, name),
              )}
            </div>
          );
        })}
        <div className="grid grid-cols-2 gap-2" aria-label={t("appearance.preview")}>
          {[day, night].map((palette, index) => (
            <div
              key={index}
              className="rounded-xl p-3 space-y-1 border border-black/5"
              style={{
                background: colour(palette, "--color-surface-rgb"),
                color: colour(palette, "--color-on-surface-rgb"),
              }}
            >
              <p
                className="text-[11px]"
                style={{ color: colour(palette, "--color-secondary-rgb") }}
              >
                {index ? t("settings.theme.dark") : t("settings.theme.light")}
              </p>
              <p className="text-sm font-semibold">{draft.name || t("appearance.newName")}</p>
              <span
                className="inline-block rounded-md px-2 py-0.5 text-[11px]"
                style={{
                  background: colour(palette, "--color-primary-rgb"),
                  color: colour(palette, "--color-surface-rgb"),
                }}
              >
                {t("appearance.sample")}
              </span>
            </div>
          ))}
        </div>
        <div className="flex justify-between gap-2">
          {existing ? (
            <Button variant="ghost" size="sm" className="text-error" onClick={onDelete}>
              {t("common.delete")}
            </Button>
          ) : (
            <span />
          )}
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!valid}
              onClick={() =>
                onSave({
                  ...draft,
                  name: draft.name.trim(),
                  paper: parseHex(draft.paper) ? draft.paper : null,
                  text: parseHex(draft.text) ? draft.text : null,
                  secondary: parseHex(draft.secondary) ? draft.secondary : null,
                })
              }
            >
              {t("common.save")}
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A style's colours in small: its page, with its main colour. */
function StyleChip({ choice }: { choice: StyleChoice }) {
  const [paper, swatch, accent] = choice.light;
  const [nightPaper, , nightAccent] = choice.dark;
  return (
    <span
      aria-hidden="true"
      className="h-8 w-8 shrink-0 rounded-lg border border-black/5 dark:border-white/10 overflow-hidden grid grid-cols-2"
    >
      <span className="flex items-end justify-center pb-1" style={{ background: paper }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: accent }} />
      </span>
      <span className="flex items-end justify-center pb-1" style={{ background: nightPaper }}>
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: nightAccent }} />
      </span>
      <span className="hidden" style={{ background: swatch }} />
    </span>
  );
}

function Toggle({
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

/** 默认封面 by day and night: a picked image, or the generated cover. */
function CoverImages({
  value,
  onChange,
}: {
  value: ReaderPreferences;
  onChange: (patch: Partial<ReaderPreferences>) => void;
}) {
  const runtime = useRuntime();
  const day = useOptionalImage(value.defaultCover);
  const night = useOptionalImage(value.nightDefaultCover);
  const pick = (key: "defaultCover" | "nightDefaultCover") =>
    void runtime.services.settings.pickBackgroundImage().then(
      (asset) => asset && onChange({ [key]: asset.id }),
      (failure: unknown) => toast({ text: describeError(failure), error: true }),
    );
  const slot = (
    label: string,
    key: "defaultCover" | "nightDefaultCover",
    image: string | undefined,
  ) => (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        aria-label={t("appearance.coverPick", { which: label })}
        onClick={() => pick(key)}
        className="w-16 aspect-[3/4] rounded-md overflow-hidden border border-surface-variant bg-surface-container flex items-center justify-center text-secondary"
      >
        {image ? (
          <img src={image} alt="" className="w-full h-full object-cover" />
        ) : (
          <Icon name="add" size={16} />
        )}
      </button>
      <span className="text-[11px] text-secondary">{label}</span>
      {value[key] && (
        <button
          type="button"
          className="text-[11px] text-primary"
          onClick={() => onChange({ [key]: undefined })}
        >
          {t("appearance.coverReset")}
        </button>
      )}
    </div>
  );
  return (
    <div className="px-4 py-3 space-y-2">
      <span className="text-sm">{t("appearance.coverDefault")}</span>
      <p className="text-[11px] text-secondary">{t("appearance.coverDefault.note")}</p>
      <div className="flex gap-6">
        {slot(t("settings.theme.light"), "defaultCover", day)}
        {slot(t("settings.theme.dark"), "nightDefaultCover", night)}
      </div>
    </div>
  );
}
