import { common } from "./common";
import { shelf } from "./shelf";
import { errors } from "./errors";
import { settings } from "./settings";
import { system } from "./system";
import { update } from "./update";

/** The interface texts in 简体中文, which define the keys. */
export const zhCN = { ...common, ...shelf, ...errors, ...settings, ...system, ...update } as const;

export type MessageKey = keyof typeof zhCN;
