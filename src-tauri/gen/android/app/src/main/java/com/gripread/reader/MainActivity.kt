package com.gripread.reader

import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  @Volatile private var insets = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"
  @Volatile private var volumeKeys = false
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Edge-to-edge WebViews do not reliably report CSS safe-area insets, so the
   * system bar and cutout insets are exposed to src/services/insets.ts in CSS px.
   * Reader-only platform controls are exposed to src/services/system.ts.
   */
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(InsetsBridge(), "GripReadInsets")
    webView.addJavascriptInterface(SystemBridge(), "GripReadSystem")
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
      val bars = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      val density = view.resources.displayMetrics.density
      insets = JSONObject()
        .put("top", bars.top / density)
        .put("right", bars.right / density)
        .put("bottom", bars.bottom / density)
        .put("left", bars.left / density)
        .toString()
      view.post {
        (view as WebView).evaluateJavascript("window.dispatchEvent(new Event('gripread-insets'))", null)
      }
      ViewCompat.onApplyWindowInsets(view, windowInsets)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  /** While enabled by the reader, volume keys turn pages instead of changing volume. */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val code = event.keyCode
    if (volumeKeys && (code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN)) {
      if (event.action == KeyEvent.ACTION_DOWN) {
        val direction = if (code == KeyEvent.KEYCODE_VOLUME_UP) "previous" else "next"
        webView?.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('gripread-volume-key', { detail: '$direction' }))",
          null,
        )
      }
      return true
    }
    return super.dispatchKeyEvent(event)
  }

  private inner class InsetsBridge {
    @JavascriptInterface
    fun get(): String = insets
  }

  private inner class SystemBridge {
    @JavascriptInterface
    fun setVolumeKeys(enabled: Boolean) {
      volumeKeys = enabled
    }

    @JavascriptInterface
    fun setKeepScreenOn(enabled: Boolean) {
      runOnUiThread {
        if (enabled) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }

    /** Hides the status and navigation bars; a swipe from an edge shows them briefly. */
    @JavascriptInterface
    fun setSystemBarsHidden(hidden: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (hidden) controller.hide(WindowInsetsCompat.Type.systemBars())
        else controller.show(WindowInsetsCompat.Type.systemBars())
      }
    }

    /** Battery level 0–100, or -1 when unknown. */
    @JavascriptInterface
    fun battery(): Int {
      val status = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return -1
      val level = status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
      val scale = status.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
      return if (level < 0 || scale <= 0) -1 else level * 100 / scale
    }
  }
}
