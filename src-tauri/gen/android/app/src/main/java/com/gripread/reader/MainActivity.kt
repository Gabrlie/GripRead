package com.gripread.reader

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  @Volatile private var insets = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  /**
   * Edge-to-edge WebViews do not reliably report CSS safe-area insets, so the
   * system bar and cutout insets are exposed to src/services/insets.ts in CSS px.
   */
  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(InsetsBridge(), "GripReadInsets")
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

  private inner class InsetsBridge {
    @JavascriptInterface
    fun get(): String = insets
  }
}
