/** Errors the interface explains, by what the core reported. */
export const errors = {
  "error.webdavUnset": "还没有设置 WebDAV 账号。",
  "error.webdavAuth": "WebDAV 账号或密码不正确。",
  "error.webdavMissing": "WebDAV 地址不存在，请检查服务器地址。",
  "error.webdavFull": "WebDAV 空间不足。",
  "error.address": "服务器地址需要以 https:// 或 http:// 开头。",
  "error.webdavUnreachable": "无法连接 WebDAV：{message}",
  "error.notBackup": "这不是 GripRead 的备份文件。",
  "error.newerBackup": "这个备份来自更新版本的 GripRead，请先升级。",
} as const;
