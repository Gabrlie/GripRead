import { common } from "./common";
import { translation } from "./translation";
import { cloud } from "./cloud";
import { sources } from "./sources";
import { reader } from "./reader";
import { shelf } from "./shelf";
import { errors } from "./errors";
import { settings } from "./settings";
import { system } from "./system";
import { update } from "./update";

export const en = {
  ...common,
  ...translation,
  ...cloud,
  ...sources,
  ...reader,
  ...shelf,
  ...errors,
  ...settings,
  ...system,
  ...update,
};
