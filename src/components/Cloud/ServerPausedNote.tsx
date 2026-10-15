import { useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";
import { t } from "../../i18n";

/** While the GripRead server is connected, WebDAV pauses; says so here. */
export function ServerPausedNote() {
  const sync = useRuntime().services.sync;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let active = true;
    void sync.getServer().then(
      (status) => active && setConnected(status.connected),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [sync]);
  if (!connected) return null;
  return (
    <p role="note" className="rounded-xl bg-surface-container p-3 text-xs text-secondary">
      {t("cloud.paused")}
    </p>
  );
}
