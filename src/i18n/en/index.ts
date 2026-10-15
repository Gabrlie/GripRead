import { common } from "./common";
import { sources } from "./sources";
import { reader } from "./reader";
import { shelf } from "./shelf";
import { errors } from "./errors";
import { settings } from "./settings";
import { system } from "./system";
import { update } from "./update";

export const en = {
  ...common,
  ...sources,
  ...reader,
  ...shelf,
  ...errors,
  ...settings,
  ...system,
  ...update,
};
