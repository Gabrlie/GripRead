import type { ComponentProps } from "react";
import { cn } from "cn";
export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "group/card rounded-xl overflow-hidden bg-surface-container-low text-sm text-on-surface ring-1 ring-on-surface/10",
        className,
      )}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-4", className)} {...props} />;
}
