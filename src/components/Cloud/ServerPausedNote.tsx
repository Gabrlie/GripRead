import { useEffect, useState } from "react";
import { useRuntime } from "../../application/runtime";

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
      已连接 GripRead 服务器，WebDAV 暂停；在 设置 › 服务器同步 断开后恢复。
    </p>
  );
}
