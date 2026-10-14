package com.gripread.reader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallArgs {
  var path: String = ""
}

/**
 * 检查更新 for crates/core/src/update.rs: the ABIs the device runs, a cache
 * folder the installer can read the APK from, and handing the downloaded
 * APK to the system installer.
 */
@TauriPlugin
class UpdatePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun info(invoke: Invoke) {
    val folder = File(activity.cacheDir, "updates")
    folder.mkdirs()
    val result = JSObject()
    result.put("abis", JSArray(Build.SUPPORTED_ABIS.toList()))
    result.put("folder", folder.absolutePath)
    invoke.resolve(result)
  }

  @Command
  fun install(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)
    val result = JSObject()
    // Android 8+ asks the reader to allow installs from GripRead once.
    if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
      activity.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
      )
      result.put("needsPermission", true)
      invoke.resolve(result)
      return
    }
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(args.path))
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      activity.startActivity(intent)
    } catch (error: Exception) {
      invoke.reject("无法打开系统安装程序：${error.message}")
      return
    }
    result.put("needsPermission", false)
    invoke.resolve(result)
  }
}
