import { useEffect, useRef, useState } from "react";
import { installUpdate, type InstallProgress } from "../../application/updates";
import type { UpdateService } from "../../services/contracts";
import { describeError } from "../Cloud/format";

export type InstallState =
  | { phase: "idle" }
  | { phase: "downloading"; progress: InstallProgress | null }
  | { phase: "started" }
  | { phase: "permission" }
  | { phase: "failed"; error: string };

/** Downloads and installs an update, with progress and cancelling. */
export function useUpdateInstall(service: UpdateService) {
  const [state, setState] = useState<InstallState>({ phase: "idle" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const start = (version: string) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ phase: "downloading", progress: null });
    void installUpdate(
      service,
      version,
      (progress) => {
        if (!controller.signal.aborted) setState({ phase: "downloading", progress });
      },
      controller.signal,
    ).then(
      (outcome) => {
        if (controller.signal.aborted) return;
        setState({ phase: outcome === "needsPermission" ? "permission" : "started" });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return setState({ phase: "idle" });
        setState({ phase: "failed", error: describeError(error) });
      },
    );
  };

  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    setState({ phase: "idle" });
  };

  return { state, start, cancel };
}
