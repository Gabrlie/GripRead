import type { ReactNode } from "react";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

export interface PanelStatusProps {
  actionError: string | null;
  retryAction: (() => void) | null;
  toolsLoading: boolean;
  toolsError: string | null;
  reloadTools: () => void;
}

/** Shared action error, tool loading, and tool failure states shown in panels. */
export function PanelStatus({
  actionError,
  retryAction,
  toolsLoading,
  toolsError,
  reloadTools,
}: PanelStatusProps) {
  return (
    <>
      {actionError && (
        <div role="alert" className="text-xs text-error space-y-2">
          <p>{actionError}</p>
          {retryAction && (
            <Button variant="outline" size="sm" onClick={retryAction}>
              重试操作
            </Button>
          )}
        </div>
      )}
      {toolsLoading && (
        <p role="status" className="text-xs text-secondary">
          正在读取书籍信息…
        </p>
      )}
      {toolsError && (
        <div role="alert" className="text-xs text-error">
          <p>{toolsError}</p>
          <Button variant="outline" size="sm" onClick={reloadTools}>
            重新加载
          </Button>
        </div>
      )}
    </>
  );
}

interface PanelShellProps {
  title: string;
  description: string;
  onClose: () => void;
  status: PanelStatusProps;
  children: ReactNode;
}

/** The dialog used by reader tool panels other than Settings. */
export function PanelShell({ title, description, onClose, status, children }: PanelShellProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-surface border border-surface-variant/40 rounded-2xl sm:max-w-md max-h-[72dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <PanelStatus {...status} />
        {children}
      </DialogContent>
    </Dialog>
  );
}
