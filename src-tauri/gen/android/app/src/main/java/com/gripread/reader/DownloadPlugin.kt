package com.gripread.reader

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class DownloadUpdateArgs {
  var active: Boolean = false
  var title: String = ""
  var text: String = ""
  var progress: Int = 0
  var max: Int = 0
}

/**
 * The 下载管理 notification for src-tauri/src/downloads.rs: while chapters
 * download, a foreground service keeps the process alive in the background
 * and shows the progress; its 停止 reaches the page as a `stop` event.
 */
@TauriPlugin
class DownloadPlugin(private val activity: Activity) : Plugin(activity) {
  private var asked = false

  override fun load(webView: android.webkit.WebView) {
    instance = this
  }

  @Command
  fun update(invoke: Invoke) {
    val args = invoke.parseArgs(DownloadUpdateArgs::class.java)
    val context = activity.applicationContext
    if (!args.active) {
      context.stopService(Intent(context, DownloadService::class.java))
      invoke.resolve()
      return
    }
    if (Build.VERSION.SDK_INT >= 33 && !asked &&
      ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      asked = true
      ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7301)
    }
    val intent = Intent(context, DownloadService::class.java)
      .putExtra("title", args.title)
      .putExtra("text", args.text)
      .putExtra("progress", args.progress)
      .putExtra("max", args.max)
    try {
      ContextCompat.startForegroundService(context, intent)
    } catch (_: Exception) {
      // Starting from the background can be refused; the queue still runs while visible.
    }
    invoke.resolve()
  }

  internal fun stopped() {
    trigger("stop", JSObject())
  }

  companion object {
    @Volatile var instance: DownloadPlugin? = null
  }
}

class DownloadService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      DownloadPlugin.instance?.stopped()
      stopSelf()
      return START_NOT_STICKY
    }
    val notification = build(
      intent?.getStringExtra("title") ?: "正在缓存",
      intent?.getStringExtra("text") ?: "",
      intent?.getIntExtra("progress", 0) ?: 0,
      intent?.getIntExtra("max", 0) ?: 0,
    )
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  private fun build(title: String, text: String, progress: Int, max: Int): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "下载管理", NotificationManager.IMPORTANCE_LOW),
      )
    }
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, DownloadService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setProgress(max, progress.coerceAtMost(max), max <= 0)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setContentIntent(open)
      .addAction(0, "停止", stop)
      .build()
  }

  companion object {
    private const val CHANNEL = "downloads"
    private const val NOTIFICATION_ID = 7302
    private const val ACTION_STOP = "com.gripread.reader.DOWNLOAD_STOP"
  }
}
