import { useT } from "../../i18n";
import { Button } from "./button";

/**
 * Where a page's content did not load: a plain line and 重试 (the failure
 * itself was told in a toast).
 */
export function LoadFailed({
  onRetry,
  className = "",
}: {
  onRetry: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={`flex flex-col items-center gap-2 py-10 text-xs text-secondary ${className}`}>
      <span>{t("common.loadFailed")}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
