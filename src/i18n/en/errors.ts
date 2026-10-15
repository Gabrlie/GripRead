import type { Messages } from "../types";
import type { errors as zh } from "../zh-CN/errors";

export const errors = {
  "error.webdavUnset": "No WebDAV account is set up yet.",
  "error.webdavAuth": "The WebDAV account or password is wrong.",
  "error.webdavMissing": "The WebDAV address does not exist; check the server address.",
  "error.webdavFull": "The WebDAV storage is full.",
  "error.address": "The server address must start with https:// or http://.",
  "error.webdavUnreachable": "Could not reach WebDAV: {message}",
  "error.notBackup": "This is not a GripRead backup file.",
  "error.newerBackup": "This backup comes from a newer GripRead; update first.",
} satisfies Messages<typeof zh>;
