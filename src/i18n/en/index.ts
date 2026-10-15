import { common } from "./common";
import { shelf } from "./shelf";
import { errors } from "./errors";
import { settings } from "./settings";
import { system } from "./system";
import { update } from "./update";

export const en = { ...common, ...shelf, ...errors, ...settings, ...system, ...update };
