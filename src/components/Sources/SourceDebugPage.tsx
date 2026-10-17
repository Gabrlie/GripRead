import { useEffect, useRef, useState } from "react";
import type { SourceService } from "../../services/contracts";
import { FullPage } from "../Layout/FullPage";
import { Button } from "../ui/button";
import { Icon } from "../ui/Icon";
import { t } from "../../i18n";
import { describeError } from "../Cloud/format";

/**
 * Legado's 书源调试: runs search → details → contents → first chapter for a
 * keyword (or `::发现地址`, a book address, `++目录地址`, `--正文地址`) and
 * shows each step and request as it happens.
 */
export function SourceDebugPage({
  service,
  url,
  onClose,
}: {
  service: SourceService;
  url: string;
  onClose: () => void;
}) {
  const [key, setKey] = useState("我的");
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const runningRef = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const track = (id: string | null) => {
    runningRef.current = id;
    setRunning(id);
  };

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    void service
      .onDebug((event) => {
        if (runningRef.current !== event.operationId) return;
        setLines((list) => [...list, event.line]);
        if (event.done) track(null);
      })
      .then((stop) => {
        if (active) unsubscribe = stop;
        else stop();
      });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [service]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [lines]);

  const start = () => {
    const operationId = `debug-${Date.now()}`;
    setLines([]);
    track(operationId);
    void service.debug({ operationId, url, key: key.trim() }).catch((failure: unknown) => {
      setLines([`✗ ${describeError(failure)}`]);
      track(null);
    });
  };

  return (
    <FullPage label={t("srcDebug.title")} onClose={onClose} layer="z-[46]">
      <div className="flex gap-2">
        <input
          aria-label={t("srcDebug.keyword")}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && !running && start()}
          className="flex-1 min-w-0 h-10 rounded-xl bg-surface-container-low px-3 text-sm outline-none"
        />
        {running ? (
          <Button variant="outline" onClick={() => void service.cancel(running)}>
            <Icon name="stop" size={15} />
            {t("search.stop")}
          </Button>
        ) : (
          <Button disabled={!key.trim()} onClick={start}>
            <Icon name="play" size={15} />
            {t("srcDebug.start")}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-secondary px-1">{t("srcDebug.note")}</p>
      <div
        role="log"
        aria-label={t("srcDebug.log")}
        className="rounded-xl bg-surface-container-low p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all min-h-40"
      >
        {lines.length === 0 && !running && (
          <span className="text-secondary">{t("srcDebug.idle")}</span>
        )}
        {lines.map((line, index) => (
          <div
            key={index}
            className={
              line.startsWith("✗")
                ? "text-error"
                : line.startsWith("︽") || line.startsWith("✓")
                  ? "text-primary font-semibold mt-1"
                  : line.startsWith("  ")
                    ? "text-secondary"
                    : ""
            }
          >
            {line}
          </div>
        ))}
        {running && <div className="text-secondary animate-pulse">…</div>}
        <div ref={end} />
      </div>
    </FullPage>
  );
}
