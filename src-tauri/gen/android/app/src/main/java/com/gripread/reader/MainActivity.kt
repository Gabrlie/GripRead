package com.gripread.reader

import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.os.BatteryManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.ActionMode
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

class MainActivity : TauriActivity() {
  @Volatile private var insets = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}"
  @Volatile private var volumeKeys = false
  @Volatile private var customSelectionMenu = false
  private var webView: WebView? = null
  private var tts: TextToSpeech? = null
  @Volatile private var ttsReady = false

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
    webView.addJavascriptInterface(SpeechBridge(), "GripReadTts")
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

  /**
   * While the reader shows its own selection menu (src/components/Reader),
   * the WebView's floating copy/share toolbar is emptied so only that menu
   * appears; the selection handles stay.
   */
  override fun onActionModeStarted(mode: ActionMode) {
    super.onActionModeStarted(mode)
    if (customSelectionMenu) mode.menu.clear()
  }

  override fun onDestroy() {
    tts?.shutdown()
    tts = null
    super.onDestroy()
  }

  private fun speechEvent(type: String, id: String) {
    val detail = JSONObject().put("type", type).put("id", id).toString()
    webView?.post {
      webView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('gripread-tts', { detail: $detail }))",
        null,
      )
    }
  }

  /**
   * Read-aloud for src/services/speech.ts. A batch of paragraphs is queued at
   * once, so speech continues while the page is in the background; progress
   * returns as `gripread-tts` events.
   */
  private inner class SpeechBridge {
    private fun engine(): TextToSpeech {
      tts?.let { return it }
      val created = TextToSpeech(this@MainActivity) { status ->
        ttsReady = status == TextToSpeech.SUCCESS
        if (ttsReady) tts?.language = Locale.getDefault()
        speechEvent(if (ttsReady) "ready" else "unavailable", "")
      }
      created.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) = speechEvent("start", utteranceId)
        override fun onDone(utteranceId: String) = speechEvent("done", utteranceId)
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String) = speechEvent("error", utteranceId)
        override fun onError(utteranceId: String, errorCode: Int) = speechEvent("error", utteranceId)
      })
      tts = created
      return created
    }

    /** Starts the engine; `ready` or `unavailable` follows as an event. */
    @JavascriptInterface
    fun prepare() {
      runOnUiThread { engine() }
    }

    @JavascriptInterface
    fun ready(): Boolean = ttsReady

    /** `items`: a JSON array of `{ id, text }`; `flush` replaces the queue. */
    @JavascriptInterface
    fun speak(items: String, rate: Float, pitch: Float, voice: String, flush: Boolean) {
      runOnUiThread {
        val speech = engine()
        if (!ttsReady) return@runOnUiThread
        speech.setSpeechRate(rate)
        speech.setPitch(pitch)
        if (voice.isNotEmpty()) speech.voices?.firstOrNull { it.name == voice }?.let { speech.voice = it }
        val list = JSONArray(items)
        for (index in 0 until list.length()) {
          val item = list.getJSONObject(index)
          val mode = if (flush && index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
          speech.speak(item.getString("text"), mode, null, item.getString("id"))
        }
      }
    }

    @JavascriptInterface
    fun stop() {
      runOnUiThread { tts?.stop() }
    }

    /** Installed voices as a JSON array of `{ name, label }`. */
    @JavascriptInterface
    fun voices(): String {
      val result = JSONArray()
      if (!ttsReady) return result.toString()
      tts?.voices?.sortedBy { it.name }?.forEach { voice ->
        if (!voice.isNetworkConnectionRequired) {
          result.put(JSONObject().put("name", voice.name).put("label", voice.locale.displayName + " · " + voice.name))
        }
      }
      return result.toString()
    }
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

    @JavascriptInterface
    fun setSelectionMenu(enabled: Boolean) {
      customSelectionMenu = enabled
    }

    /** Window brightness from 0 to 1, or a negative value to follow the system. */
    @JavascriptInterface
    fun setBrightness(value: Float) {
      runOnUiThread {
        val attributes = window.attributes
        attributes.screenBrightness =
          if (value < 0f) WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE else value.coerceIn(0.01f, 1f)
        window.attributes = attributes
      }
    }

    /** `auto`, `portrait`, or `landscape` (sensor-based within each). */
    @JavascriptInterface
    fun setOrientation(orientation: String) {
      runOnUiThread {
        requestedOrientation = when (orientation) {
          "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
          "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
          else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
      }
    }

    /** Opens the system share sheet with plain text. */
    @JavascriptInterface
    fun share(text: String) {
      runOnUiThread {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        startActivity(Intent.createChooser(send, null))
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
