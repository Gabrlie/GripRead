import { open, save } from "@tauri-apps/plugin-dialog";
import type { PickedFile } from "../types/generated";
import { native, type TransportError } from "./transport";
import { t } from "../i18n";

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickOptions {
  multiple?: boolean;
  filters?: FileFilter[];
}

/** The browser's file chooser; resolves with nothing when it is closed. */
function choose(options: {
  multiple?: boolean;
  accept?: string;
  folder?: boolean;
}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = Boolean(options.multiple || options.folder);
    if (options.accept) input.accept = options.accept;
    if (options.folder) input.setAttribute("webkitdirectory", "");
    input.style.display = "none";
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));
    document.body.append(input);
    input.click();
  });
}

/** Sends one file to the server; answers the `upload:` path commands accept. */
export async function upload(file: File): Promise<string> {
  const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    credentials: "same-origin",
    body: file,
  });
  const body = (await response.json()) as { path?: string } & Partial<TransportError>;
  if (!response.ok || !body.path)
    throw {
      code: body.code ?? "io",
      message: body.message ?? t("files.uploadFailed"),
    } as TransportError;
  return body.path;
}

const accept = (filters?: FileFilter[]) =>
  filters?.flatMap((filter) => filter.extensions.map((extension) => `.${extension}`)).join(",");

/**
 * Picks files as paths the core can open: the system dialog in the app,
 * or the browser's chooser with the files uploaded on the server.
 */
export async function pickFiles(options: PickOptions & { multiple: true }): Promise<string[]>;
export async function pickFiles(options: PickOptions): Promise<string | null>;
export async function pickFiles(options: PickOptions): Promise<string | string[] | null> {
  if (native) {
    const selected = await open({
      multiple: options.multiple ?? false,
      directory: false,
      filters: options.filters,
    });
    if (options.multiple)
      return selected === null ? [] : Array.isArray(selected) ? selected : [selected];
    return typeof selected === "string" ? selected : null;
  }
  const files = await choose({ multiple: options.multiple, accept: accept(options.filters) });
  const paths = await Promise.all(files.map(upload));
  return options.multiple ? paths : (paths[0] ?? null);
}

/** A folder for the app's batch import; the web version uploads its `.txt` and `.epub` files. */
export async function pickTxtFolderFiles(): Promise<PickedFile[] | string | null> {
  if (native) {
    const folder = await open({ multiple: false, directory: true });
    return typeof folder === "string" ? folder : null;
  }
  const files = (await choose({ folder: true })).filter((file) => /\.(txt|epub)$/i.test(file.name));
  files.sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(
    files.slice(0, 1000).map(async (file) => ({ path: await upload(file), name: file.name })),
  );
}

/**
 * Where to save a file: the app's save dialog (`null` when closed); the web
 * version keeps it on the server for {@link finishSave} to download.
 */
export async function pickSaveTarget(options: {
  defaultPath: string;
  filters?: FileFilter[];
}): Promise<string | null> {
  if (native) return save(options);
  return "";
}

/** Downloads the file a command saved, in the web version. */
export async function finishSave(saved: boolean): Promise<boolean> {
  if (native || !saved) return saved;
  const response = await fetch("/api/export", { credentials: "same-origin" });
  if (!response.ok) return false;
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : "export";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
