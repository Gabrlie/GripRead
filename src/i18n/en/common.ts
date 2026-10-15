import type { Messages } from "../types";
import type { common as zh } from "../zh-CN/common";

export const common = {
  "common.retry": "Retry",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.close": "Close",
  "common.back": "Back",
  "common.confirm": "OK",
  "common.loading": "Loading…",
  "common.none": "None",
  "common.off": "Off",
  "common.on": "On",
  "common.edit": "Edit",
  "common.import": "Import",
  "common.export": "Export",
  "common.done": "Done",
  "common.unknownTime": "Unknown time",
  "common.days": "{count} {count|day|days}",
  "common.books": "{count} {count|book|books}",
  "common.followSystem": "System",
} satisfies Messages<typeof zh>;
