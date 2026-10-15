import { common } from "./common";
import { reader } from "./reader";
import { shelf } from "./shelf";
import { errors } from "./errors";
import { settings } from "./settings";
import { system } from "./system";
import { update } from "./update";

export const en = { ...common, ...reader, ...shelf, ...errors, ...settings, ...system, ...update };
