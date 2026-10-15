import { t } from "../i18n";

/**
 * A readable default device name for backups and progress: the phone model
 * from the WebView's user agent when it reports one, else the platform.
 */
export function defaultDeviceName(userAgent = navigator.userAgent): string {
  const android = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?[;)]/.exec(userAgent);
  // Reduced user agents report the model as "K".
  if (android && android[1].trim().length > 1) return android[1].trim();
  if (/Android/i.test(userAgent)) return t("device.android");
  if (/Mac OS X/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return t("device.windows");
  if (/Linux/i.test(userAgent)) return t("device.linux");
  return t("device.default");
}
