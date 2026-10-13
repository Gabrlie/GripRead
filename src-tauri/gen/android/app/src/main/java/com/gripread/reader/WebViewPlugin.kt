package com.gripread.reader

import android.annotation.SuppressLint
import android.app.Activity
import android.app.Dialog
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONTokener

@InvokeArg
class RenderArgs {
  lateinit var url: String
  var html: String? = null
  var headers: Map<String, String> = emptyMap()
  var js: String? = null
  var sourceRegex: String? = null
  var overrideUrlRegex: String? = null
  var delayMs: Long = 0
  var timeoutMs: Long = 60_000
}

@InvokeArg
class BrowseArgs {
  lateinit var url: String
  var title: String = ""
  var headers: Map<String, String> = emptyMap()
  var html: String? = null
}

/**
 * The book sources' WebView for src-tauri/src/webview.rs, as Legado's
 * BackstageWebView and WebViewActivity: `render` loads a page off screen
 * and answers with its HTML or a script's result; `browse` shows a page
 * for logging in or a verification and answers when it is closed.
 * Cookies come from and go back to the source's cookie store.
 */
@TauriPlugin
class WebViewPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())

  private fun seedCookies(url: String, headers: Map<String, String>) {
    val cookie = headers.entries.firstOrNull { it.key.equals("Cookie", true) }?.value ?: return
    val manager = CookieManager.getInstance()
    cookie.split(";").map { it.trim() }.filter { it.isNotEmpty() }.forEach { manager.setCookie(url, it) }
  }

  private fun requestHeaders(headers: Map<String, String>) =
    headers.filterKeys { !it.equals("Cookie", true) && !it.equals("User-Agent", true) }

  @SuppressLint("SetJavaScriptEnabled")
  private fun prepare(view: WebView, headers: Map<String, String>) {
    view.settings.javaScriptEnabled = true
    view.settings.domStorageEnabled = true
    view.settings.blockNetworkImage = true
    headers.entries.firstOrNull { it.key.equals("User-Agent", true) }?.value?.let {
      view.settings.userAgentString = it
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
  }

  private fun decode(result: String?): String {
    if (result == null || result == "null") return ""
    return try {
      when (val value = JSONTokener(result).nextValue()) {
        is String -> value
        else -> value.toString()
      }
    } catch (_: Exception) {
      result
    }
  }

  @Command
  fun render(invoke: Invoke) {
    val args = invoke.parseArgs(RenderArgs::class.java)
    main.post {
      val view = WebView(activity)
      var done = false
      val source = args.sourceRegex?.takeIf { it.isNotEmpty() }?.toRegex()
      val override = args.overrideUrlRegex?.takeIf { it.isNotEmpty() }?.toRegex()
      fun finish(url: String, body: String?, error: String? = null) {
        if (done) return
        done = true
        val cookies = CookieManager.getInstance().getCookie(url)
        CookieManager.getInstance().flush()
        main.post { view.stopLoading(); view.destroy() }
        if (error != null) {
          invoke.reject(error)
        } else {
          invoke.resolve(JSObject().put("url", url).put("body", body ?: "").put("cookies", cookies))
        }
      }
      val started = System.currentTimeMillis()
      // A script's result can take a while to appear: it is asked again
      // until it is not empty, as Legado does.
      fun evaluate() {
        if (done) return
        val script = args.js?.takeIf { it.isNotBlank() } ?: "document.documentElement.outerHTML"
        view.evaluateJavascript(script) { raw ->
          val value = decode(raw)
          if (value.isNotEmpty() || System.currentTimeMillis() - started > args.timeoutMs) {
            finish(view.url ?: args.url, value)
          } else {
            main.postDelayed({ evaluate() }, 500)
          }
        }
      }
      prepare(view, args.headers)
      view.webViewClient = object : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {}

        override fun onPageFinished(view: WebView, url: String?) {
          if (source == null && override == null) {
            main.postDelayed({ evaluate() }, args.delayMs.coerceAtLeast(300))
          }
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
          val url = request.url.toString()
          if (source != null && source.containsMatchIn(url)) main.post { finish(url, url) }
          return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          val url = request.url.toString()
          if (override != null && override.containsMatchIn(url)) {
            main.post { finish(url, url) }
            return true
          }
          return false
        }
      }
      seedCookies(args.url, args.headers)
      main.postDelayed({ finish(args.url, null, "网页加载超时") }, args.timeoutMs + 2_000)
      val html = args.html
      if (html != null) {
        view.loadDataWithBaseURL(args.url, html, "text/html", "utf-8", args.url)
      } else {
        view.loadUrl(args.url, requestHeaders(args.headers))
      }
    }
  }

  @Command
  fun browse(invoke: Invoke) {
    val args = invoke.parseArgs(BrowseArgs::class.java)
    main.post {
      val dialog = Dialog(activity, android.R.style.Theme_DeviceDefault_Light_NoActionBar)
      val view = WebView(activity)
      var done = false
      fun finish(html: String) {
        if (done) return
        done = true
        val url = view.url ?: args.url
        val cookies = CookieManager.getInstance().getCookie(url)
        CookieManager.getInstance().flush()
        invoke.resolve(JSObject().put("url", url).put("body", html).put("cookies", cookies))
        main.post { view.destroy() }
      }
      prepare(view, args.headers)
      view.settings.blockNetworkImage = false
      view.webViewClient = WebViewClient()
      val bar = LinearLayout(activity).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(32, 24, 16, 8)
      }
      bar.addView(
        TextView(activity).apply {
          text = args.title.ifEmpty { "网页" }
          textSize = 16f
        },
        LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
      )
      bar.addView(Button(activity).apply {
        text = "完成"
        setOnClickListener {
          view.evaluateJavascript("document.documentElement.outerHTML") { raw ->
            finish(decode(raw))
            dialog.dismiss()
          }
        }
      })
      val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
      root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
      root.addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
      dialog.setContentView(root)
      dialog.setOnKeyListener { _, code, event ->
        if (code == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP && view.canGoBack()) {
          view.goBack()
          true
        } else {
          false
        }
      }
      dialog.setOnDismissListener { finish("") }
      seedCookies(args.url, args.headers)
      val html = args.html
      if (html != null) {
        view.loadDataWithBaseURL(args.url, html, "text/html", "utf-8", args.url)
      } else {
        view.loadUrl(args.url, requestHeaders(args.headers))
      }
      dialog.show()
    }
  }
}
