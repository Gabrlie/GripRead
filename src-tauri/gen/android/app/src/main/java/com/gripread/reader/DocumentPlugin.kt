package com.gripread.reader

import android.app.Activity
import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class OpenDocumentArgs {
  lateinit var uri: String
}

/**
 * Opens a picked document for the Rust import worker (src-tauri/src/documents.rs).
 * The descriptor is detached, so Rust owns and closes it.
 */
@TauriPlugin
class DocumentPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun openDocument(invoke: Invoke) {
    try {
      val uri = Uri.parse(invoke.parseArgs(OpenDocumentArgs::class.java).uri)
      val resolver = activity.contentResolver
      var name: String? = null
      resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (column >= 0 && cursor.moveToFirst()) name = cursor.getString(column)
      }
      val descriptor =
        resolver.openFileDescriptor(uri, "r") ?: throw IllegalStateException("The document provider returned no file")
      val result = JSObject()
      result.put("fd", descriptor.detachFd())
      result.put("name", name)
      invoke.resolve(result)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The document cannot be opened")
    }
  }
}
