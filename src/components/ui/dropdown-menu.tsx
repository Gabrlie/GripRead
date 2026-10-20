import { Menu } from "@base-ui/react/menu";
import { cn } from "cn";

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export function DropdownMenuContent({
  align = "end",
  sideOffset = 6,
  anchor,
  className,
  children,
  ...props
}: Menu.Popup.Props & Pick<Menu.Positioner.Props, "align" | "sideOffset" | "anchor">) {
  return (
    <Menu.Portal>
      <Menu.Positioner align={align} sideOffset={sideOffset} anchor={anchor} className="z-[60]">
        <Menu.Popup
          className={cn(
            "glass-dropdown min-w-48 rounded-2xl p-1.5 text-on-surface outline-none animate-in fade-in-0 zoom-in-95",
            className,
          )}
          style={{
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
            backdropFilter: "blur(40px) saturate(180%)",
            ...props.style,
          }}
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
        "flex items-center gap-2 rounded-xl px-3 py-2 text-xs outline-none cursor-pointer data-[highlighted]:bg-surface-container data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed transition-colors",
        className,
      )}
      {...props}
    />
  );
}
