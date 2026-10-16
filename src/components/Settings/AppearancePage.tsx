import { useState } from "react";
import { useSettings } from "../../application/runtime";
import { parseHex, stylePalette } from "../../application/theme-colors";
import { languageChoice, setLanguage, t, type LanguageChoice } from "../../i18n";
import type { InterfaceStyle, ReaderPreferences } from "../../types/generated";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { toast } from "../ui/toast";
import {
  PINNED_MAX,
  StyleSwatch,
  choose,
  chosenStyle,
  pinnedChoices,
  styleChoices,
  type StyleChoice,
} from "./interface-styles";

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
        <div
          role="radiogroup"
          aria-label={t("settings.interfaceStyle")}
          className="grid grid-cols-3 sm:grid-cols-4 gap-2 p-4"
        >
          {all.map((choice) => (
            <div key={choice.id} className="relative">
              <StyleSwatch
                choice={choice}
                selected={chosen === choice.id}
                onChoose={() => store.set(choose(choice))}
              />
              <div className="mt-1 flex justify-center gap-1">
                <button
                  type="button"
                  aria-pressed={pinned.includes(choice.id)}
                  aria-label={t("appearance.pin", { name: choice.name })}
                  onClick={() => togglePin(choice)}
                  className={`h-6 w-6 rounded-full inline-flex items-center justify-center ${pinned.includes(choice.id) ? "text-primary" : "text-secondary"}`}
                >
                  <Icon name="push_pin" size={13} />
                </button>
                {choice.custom && (
                  <button
                    type="button"
                    aria-label={t("appearance.edit", { name: choice.name })}
                    onClick={() => setEditing(choice.custom!)}
                    className="h-6 w-6 rounded-full inline-flex items-center justify-center text-secondary"
                  >
                    <Icon name="edit" size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 pb-4">
          <Button
            size="sm"
            variant="outline"
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
            <Icon name="add" size={14} />
            {t("appearance.new")}
          </Button>
        </div>
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
