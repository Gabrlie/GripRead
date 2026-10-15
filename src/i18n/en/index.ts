import { common } from "./common";
import { errors } from "./errors";
import { settings } from "./settings";
import { system } from "./system";
import { update } from "./update";

export const en = { ...common, ...errors, ...settings, ...system, ...update };
