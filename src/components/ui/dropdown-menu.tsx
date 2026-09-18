import { Menu } from "@base-ui/react/menu";
import { cn } from "cn";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export function DropdownMenuContent({
  align = "end",
  sideOffset = 6,
  className,
  children,
  ...props
}: Menu.Popup.Props & Pick<Menu.Positioner.Props, "align" | "sideOffset">) {
  return (
    <Menu.Portal>
      <Menu.Positioner align={align} sideOffset={sideOffset} className="z-[60]">
        <Menu.Popup
          className={cn(
            "min-w-48 rounded-2xl bg-surface border border-surface-variant/50 p-1.5 text-on-surface shadow-xl outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}
export function DropdownMenuItem({ className, ...props }: Menu.Item.Props) {
  return (
    <Menu.Item
      className={cn(
        "flex items-center gap-2 rounded-xl px-3 py-2 text-xs outline-none cursor-pointer data-[highlighted]:bg-surface-container data-[disabled]:opacity-40 data-[disabled]:cursor-default",
        className,
      )}
      {...props}
    />
  );
}
