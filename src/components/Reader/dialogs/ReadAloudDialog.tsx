import { useEffect, useState } from "react";
import type { SpeechStatus, SpeechVoice } from "../../../services/speech";
import type { ReadAloudSnapshot } from "../../../reader/read-aloud";
import { Button } from "../../ui/button";
import { Dialog, DialogHeader, DialogTitle, SheetContent } from "../../ui/dialog";
import { Icon } from "../../ui/Icon";
import { Slider } from "../../ui/slider";
import { formatClock, t } from "../../../i18n";

const timers = (): [number | null, string][] => [
  [null, t("common.off")],
  [15, t("aloud.15")],
  [30, t("aloud.30")],
  [60, t("aloud.60")],
  [90, t("aloud.90")],
];

/**
 * Legado's ReadAloudDialog: previous and next paragraph, play or pause,
 * stop, speed, pitch, voice, and a sleep timer.
 */
export function ReadAloudDialog({
  snapshot,
  status: readStatus,
  onOpenSettings,
  rate,
  pitch,
  voice,
  loadVoices,
  onPlay,
  onPause,
  onStop,
  onSkip,
  onTimer,
  onSettings,
  onClose,
}: {
  snapshot: ReadAloudSnapshot;
  /** The engine's state, read again while it is starting. */
  status: () => SpeechStatus;
  onOpenSettings?: () => void;
  rate: number;
  pitch: number;
  voice: string | null;
  loadVoices: () => Promise<SpeechVoice[]>;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSkip: (step: -1 | 1) => void;
  onTimer: (minutes: number | null) => void;
  onSettings: (patch: {
    speechRate?: number;
    speechPitch?: number;
    speechVoice?: string | null;
  }) => void;
  onClose: () => void;
}) {
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [timer, setTimer] = useState<number | null>(null);
  const [status, setStatus] = useState(readStatus);
  useEffect(() => {
    if (status !== "pending") return;
    const poll = window.setInterval(() => setStatus(readStatus()), 300);
    return () => window.clearInterval(poll);
  }, [readStatus, status]);
  useEffect(() => {
    if (status === "ready") void loadVoices().then(setVoices, () => setVoices([]));
  }, [loadVoices, status]);
  const available = status !== "unavailable";
  const playing = snapshot.state === "playing";
  const idle = snapshot.state === "idle";
  const value = (next: number | readonly number[]) =>
    (Array.isArray(next) ? next[0] : next) as number;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        <DialogHeader>
          <DialogTitle className="font-title-editorial text-base">
            {t("reader.tool.aloud")}
          </DialogTitle>
        </DialogHeader>
        {!available ? (
          <div className="space-y-3 pb-2">
            <p className="text-sm text-secondary">{t("aloud.noEngine")}</p>
            {onOpenSettings && (
              <Button variant="outline" size="sm" onClick={onOpenSettings}>
                {t("aloud.settings")}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4 pb-2">
            {status === "pending" && (
              <p role="status" className="text-xs text-secondary">
                {t("aloud.starting")}
              </p>
            )}
            {snapshot.failed && (
              <div role="alert" className="text-xs text-error space-y-1.5">
                <p>{t("aloud.failed")}</p>
                {onOpenSettings && (
                  <Button variant="outline" size="sm" onClick={onOpenSettings}>
                    {t("aloud.settings")}
                  </Button>
                )}
              </div>
            )}
            {snapshot.current && (
              <p className="text-xs text-secondary line-clamp-2 break-words">
                {snapshot.current.text}
              </p>
            )}
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("aloud.previous")}
                disabled={idle}
                onClick={() => onSkip(-1)}
              >
                <Icon name="chevron_left" size={22} />
              </Button>
              <Button
                size="icon"
                aria-label={playing ? t("reader.aloudPause") : t("aloud.start")}
                className="h-12 w-12 rounded-full"
                onClick={playing ? onPause : onPlay}
              >
                <Icon name={playing ? "pause" : "play"} size={22} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("aloud.next")}
                disabled={idle}
                onClick={() => onSkip(1)}
              >
                <Icon name="chevron_right" size={22} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("reader.aloudStop")}
                disabled={idle}
                onClick={onStop}
              >
                <Icon name="stop" size={18} />
              </Button>
            </div>
            <label className="block space-y-2 text-xs">
              <span className="flex justify-between">
                <span>{t("aloud.rate")}</span>
                <output>{rate.toFixed(1)}×</output>
              </span>
              <Slider
                aria-label={t("aloud.rateLabel")}
                min={3}
                max={30}
                step={1}
                value={Math.round(rate * 10)}
                onValueChange={(next) => onSettings({ speechRate: value(next) / 10 })}
              />
            </label>
            <label className="block space-y-2 text-xs">
              <span className="flex justify-between">
                <span>{t("aloud.pitch")}</span>
                <output>{pitch.toFixed(1)}</output>
              </span>
              <Slider
                aria-label={t("aloud.pitchLabel")}
                min={5}
                max={20}
                step={1}
                value={Math.round(pitch * 10)}
                onValueChange={(next) => onSettings({ speechPitch: value(next) / 10 })}
              />
            </label>
            {voices.length > 0 && (
              <label className="flex items-center justify-between gap-3 text-xs">
                {t("aloud.voice")}
                <select
                  aria-label={t("aloud.voiceLabel")}
                  className="min-w-0 flex-1 max-w-[16rem] h-8 rounded-lg bg-surface-container px-2 text-xs"
                  value={voice ?? ""}
                  onChange={(event) => onSettings({ speechVoice: event.target.value || null })}
                >
                  <option value="">{t("aloud.defaultVoice")}</option>
                  {voices.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="space-y-1.5">
              <span className="text-xs">
                {t("aloud.timer")}
                {snapshot.stopsAt && (
                  <span className="ml-2 text-secondary">
                    {t("aloud.stopsAt", { time: formatClock(snapshot.stopsAt) })}
                  </span>
                )}
              </span>
              <div
                role="radiogroup"
                aria-label={t("aloud.timer")}
                className="flex flex-wrap gap-1.5"
              >
                {timers().map(([minutes, label]) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={timer === minutes}
                    onClick={() => {
                      setTimer(minutes);
                      onTimer(minutes);
                    }}
                    className={`h-7 px-2.5 rounded-full text-[11px] border ${timer === minutes ? "bg-primary text-on-primary border-primary" : "border-surface-variant"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </SheetContent>
    </Dialog>
  );
}
