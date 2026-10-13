package com.gripread.reader

import android.app.Activity
import android.net.ConnectivityManager
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The device's own HTTP proxy for src-tauri/src/network.rs (Wi-Fi proxy
 * settings or one a proxy app sets): book source requests go through it
 * when the app has no proxy of its own, and DoH is off while it is set.
 */
@TauriPlugin
class NetworkPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun systemProxy(invoke: Invoke) {
    val result = JSObject()
    val proxy = activity.getSystemService(ConnectivityManager::class.java)?.defaultProxy
    var host = proxy?.host
    var port = proxy?.port ?: -1
    if (host.isNullOrEmpty() || port <= 0) {
      host = System.getProperty("http.proxyHost")
      port = System.getProperty("http.proxyPort")?.toIntOrNull() ?: -1
    }
    if (!host.isNullOrEmpty() && port > 0) {
      result.put("host", host)
      result.put("port", port)
    }
    invoke.resolve(result)
  }
}
