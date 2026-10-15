import { useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";
import {
  LANGUAGES,
  PRESETS,
  engineFrom,
  languageName,
  presetName,
} from "../../application/translation";
import { t } from "../../i18n";
import type { EngineKind, TranslationEngine, TranslationSettings } from "../../types/generated";
import { describeError } from "../Cloud/format";
import { FullPage, PageSection } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Icon } from "../ui/Icon";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";

const KINDS: EngineKind[] = ["openAi", "claude", "gemini", "deepl"];
const AHEAD = [0, 1, 2, 3, 5];

const selectClass =
  "w-full rounded-lg border border-surface-variant bg-surface-container px-2 py-2 text-sm";

/**
 * 设置 › 翻译: engines (large language models and DeepL, with their keys
 * kept on this device), the language books are translated into, how a
 * translation reads, and translating ahead.
 */
export function TranslationSettingsPage({
  onClose,
  layer,
}: {
  onClose: () => void;
  /** Stacking above the reader when opened from it. */
  layer?: string;
}) {
  const service = useRuntime().services.translation;
  const [settings, setSettings] = useState<TranslationSettings | null>(null);
  const [editing, setEditing] = useState<TranslationEngine | null>(null);

  useEffect(() => {
    void service
      .getSettings()
      .then(setSettings, (failure: unknown) =>
        toast({ text: describeError(failure), error: true }),
      );
  }, [service]);

  if (!settings)
    return (
      <FullPage label={t("translation.title")} onClose={onClose} layer={layer}>
        {null}
      </FullPage>
    );

  const save = (next: TranslationSettings) => {
    setSettings(next);
    void service
      .saveSettings(next)
      .then(setSettings, (failure: unknown) =>
        toast({ text: describeError(failure), error: true }),
      );
  };
  const defaultId = settings.defaultEngine ?? settings.engines[0]?.id ?? null;
  const saveEngine = (engine: TranslationEngine) => {
    const exists = settings.engines.some((item) => item.id === engine.id);
    const engines = exists
      ? settings.engines.map((item) => (item.id === engine.id ? engine : item))
      : [...settings.engines, engine];
    save({ ...settings, engines, defaultEngine: settings.defaultEngine ?? engine.id });
    setEditing(null);
  };

  return (
    <FullPage label={t("translation.title")} onClose={onClose} layer={layer}>
      <PageSection title={t("translation.engines")}>
        {settings.engines.length === 0 && (
          <p className="px-4 py-3 text-xs text-secondary">{t("translation.noEngines")}</p>
        )}
        {settings.engines.map((engine) => (
          <div key={engine.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
            <button
              type="button"
              role="radio"
              aria-checked={engine.id === defaultId}
              aria-label={t("translation.setDefault")}
              onClick={() => save({ ...settings, defaultEngine: engine.id })}
              className={`h-4 w-4 shrink-0 rounded-full border ${engine.id === defaultId ? "border-primary bg-primary" : "border-outline"}`}
            />
            <button
              type="button"
              className="flex-1 min-w-0 text-left"
              onClick={() => setEditing(engine)}
            >
              <span className="block truncate">
                {engine.name}
                {engine.id === defaultId && (
                  <span className="ml-1.5 text-[11px] text-primary">
                    {t("translation.default")}
                  </span>
                )}
              </span>
              <span className="block truncate text-[11px] text-secondary">
                {t(`translation.kind.${engine.kind}`)}
                {engine.model ? ` · ${engine.model}` : ""}
              </span>
            </button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-secondary"
              aria-label={t("translation.deleteEngine", { name: engine.name })}
              onClick={() =>
                save({
                  ...settings,
                  engines: settings.engines.filter((item) => item.id !== engine.id),
                  defaultEngine:
                    settings.defaultEngine === engine.id ? null : settings.defaultEngine,
                })
              }
            >
              <Icon name="delete" size={15} />
            </Button>
          </div>
        ))}
        <div className="px-4 py-3">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1 rounded-lg border border-surface-variant px-3 text-xs">
              <Icon name="add" size={14} />
              {t("translation.addEngine")}
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {PRESETS.map((preset) => (
                <DropdownMenuItem key={preset.id} onClick={() => setEditing(engineFrom(preset))}>
                  {presetName(preset)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PageSection>

      <PageSection title={t("translation.title")}>
        <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span>{t("translation.target")}</span>
          <select
            aria-label={t("translation.target")}
            className={`${selectClass} w-40`}
            value={settings.target}
            onChange={(event) => save({ ...settings, target: event.target.value })}
          >
            {LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
              </option>
            ))}
          </select>
        </label>
        <div className="px-4 py-3 space-y-2 text-sm">
          <span>{t("translation.display")}</span>
          <div
            role="radiogroup"
            aria-label={t("translation.display")}
            className="grid grid-cols-2 gap-1 bg-surface-container p-1 rounded-lg"
          >
            {(["translated", "bilingual"] as const).map((display) => (
              <button
                key={display}
                type="button"
                role="radio"
                aria-checked={settings.display === display}
                onClick={() => save({ ...settings, display })}
                className={`h-8 rounded-md text-xs ${settings.display === display ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
              >
                {t(`translation.display.${display}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="px-4 py-3 space-y-2 text-sm">
          <span>
            {t("translation.ahead")}
            <span className="block text-[11px] text-secondary">{t("translation.ahead.note")}</span>
          </span>
          <div
            role="radiogroup"
            aria-label={t("translation.ahead")}
            className="grid grid-cols-5 gap-1 bg-surface-container p-1 rounded-lg"
          >
            {AHEAD.map((ahead) => (
              <button
                key={ahead}
                type="button"
                role="radio"
                aria-checked={settings.ahead === ahead}
                onClick={() => save({ ...settings, ahead })}
                className={`h-8 rounded-md text-xs ${settings.ahead === ahead ? "bg-surface text-primary font-semibold shadow-sm" : "text-secondary"}`}
              >
                {ahead ? t("translation.ahead.count", { count: ahead }) : t("common.off")}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
          <span>
            {t("translation.auto")}
            <span className="block text-[11px] text-secondary">{t("translation.auto.note")}</span>
          </span>
          <Switch
            aria-label={t("translation.auto")}
            checked={settings.autoTranslate}
            onCheckedChange={(autoTranslate) => save({ ...settings, autoTranslate })}
          />
        </label>
      </PageSection>

      {editing && (
        <EngineDialog
          engine={editing}
          target={settings.target}
          onSave={saveEngine}
          onClose={() => setEditing(null)}
        />
      )}
    </FullPage>
  );
}

function EngineDialog({
  engine,
  target,
  onSave,
  onClose,
}: {
  engine: TranslationEngine;
  target: string;
  onSave: (engine: TranslationEngine) => void;
  onClose: () => void;
}) {
  const service = useRuntime().services.translation;
  const [draft, setDraft] = useState(engine);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<TranslationEngine>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const field = (label: string, key: "name" | "baseUrl" | "model" | "apiKey", placeholder = "") => (
    <label className="block space-y-1 text-xs text-secondary">
      {label}
      <Input
        aria-label={label}
        value={draft[key]}
        placeholder={placeholder}
        type={key === "apiKey" ? "password" : undefined}
        autoCapitalize="none"
        onChange={(event) => set({ [key]: event.target.value })}
      />
    </label>
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid-cols-1 bg-surface rounded-2xl sm:max-w-md max-h-[85dvh] overflow-y-auto p-5 gap-3">
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("translation.editEngine")}
          </DialogTitle>
        </DialogHeader>
        {field(t("translation.engineName"), "name")}
        <label className="block space-y-1 text-xs text-secondary">
          {t("translation.kind")}
          <select
            aria-label={t("translation.kind")}
            className={selectClass}
            value={draft.kind}
            onChange={(event) => set({ kind: event.target.value as EngineKind })}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`translation.kind.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        {field(t("translation.baseUrl"), "baseUrl", t("translation.baseUrl.placeholder"))}
        {draft.kind !== "deepl" && field(t("translation.model"), "model")}
        {field(t("translation.apiKey"), "apiKey")}
        <p className="text-[11px] text-secondary">{t("translation.apiKey.note")}</p>
        {draft.kind !== "deepl" && (
          <label className="block space-y-1 text-xs text-secondary">
            {t("translation.prompt")}
            <textarea
              aria-label={t("translation.prompt")}
              rows={3}
              value={draft.prompt}
              placeholder={t("translation.prompt.placeholder")}
              onChange={(event) => set({ prompt: event.target.value })}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none resize-y"
            />
          </label>
        )}
        {result && (
          <p
            role={result.ok ? "status" : "alert"}
            className={`text-xs break-words ${result.ok ? "text-secondary" : "text-error"}`}
          >
            {result.text}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              setResult(null);
              void service
                .testEngine(draft, target)
                .then(
                  (text) => setResult({ ok: true, text: t("translation.testResult", { text }) }),
                  (failure: unknown) => setResult({ ok: false, text: describeError(failure) }),
                )
                .finally(() => setTesting(false));
            }}
          >
            {testing ? t("translation.testing") : t("translation.test")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!draft.name.trim()} onClick={() => onSave(draft)}>
            {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
