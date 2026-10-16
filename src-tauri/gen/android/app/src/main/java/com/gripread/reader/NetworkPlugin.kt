package com.gripread.reader

import android.app.Activity
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * The device's own HTTP proxy for src-tauri/src/network.rs (Wi-Fi proxy
 * settings or one a proxy app sets): book source requests go through it
 * when the app has no proxy of its own, and DoH is off while it is set.
 * A `changed` event tells the page when the network or its proxy changes
 * (a proxy app turned off), so the app checks again.
 */
@TauriPlugin
class NetworkPlugin(private val activity: Activity) : Plugin(activity) {
  override fun load(webView: android.webkit.WebView) {
    val manager = activity.getSystemService(ConnectivityManager::class.java) ?: return
    runCatching {
      manager.registerDefaultNetworkCallback(
        object : ConnectivityManager.NetworkCallback() {
          override fun onAvailable(network: Network) = changed()

          override fun onLost(network: Network) = changed()

          override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) =
            changed()
        }
      )
    }
  }

  private fun changed() {
    trigger("changed", JSObject())
  }

  /** Mobile data and other metered networks, for 仅在 Wi‑Fi 下加载网络封面. */
  @Command
  fun metered(invoke: Invoke) {
    val manager = activity.getSystemService(ConnectivityManager::class.java)
    invoke.resolve(JSObject().put("metered", manager?.isActiveNetworkMetered ?: false))
  }

  @Command
  fun systemProxy(invoke: Invoke) {
    val result = JSObject()
    val proxy = activity.getSystemService(ConnectivityManager::class.java)?.defaultProxy
    // The active network's proxy only: the JVM's http.proxyHost can stay
    // behind after a proxy app stops.
    val host = proxy?.host
    val port = proxy?.port ?: -1
    if (!host.isNullOrEmpty() && port > 0) {
      result.put("host", host)
      result.put("port", port)
    }
    invoke.resolve(result)
  }
}
