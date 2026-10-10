package com.gripread.reader

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
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

  /** Opens the system folder picker for a batch import of TXT files. */
  @Command
  fun pickFolder(invoke: Invoke) {
    try {
      startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), "folderPicked")
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The folder picker cannot be opened")
    }
  }

  /** Lists `.txt` documents in the picked tree, three folder levels deep. */
  @ActivityCallback
  fun folderPicked(invoke: Invoke, result: ActivityResult) {
    val files = JSArray()
    val tree = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || tree == null) {
      invoke.resolve(JSObject().put("files", files))
      return
    }
    try {
      val found = mutableListOf<Pair<String, String>>()
      listTxt(tree, DocumentsContract.getTreeDocumentId(tree), 0, found)
      found.sortBy { it.second }
      for ((uri, name) in found) files.put(JSObject().put("path", uri).put("name", name))
      invoke.resolve(JSObject().put("files", files))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The folder cannot be read")
    }
  }

  private fun listTxt(tree: Uri, parent: String, depth: Int, found: MutableList<Pair<String, String>>) {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
    val columns = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
    )
    activity.contentResolver.query(children, columns, null, null, null)?.use { cursor ->
      while (cursor.moveToNext() && found.size < 1000) {
        val id = cursor.getString(0) ?: continue
        val name = cursor.getString(1) ?: continue
        if (name.startsWith(".")) continue
        if (cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) {
          if (depth < 3) listTxt(tree, id, depth + 1, found)
        } else if (name.endsWith(".txt", ignoreCase = true)) {
          found.add(DocumentsContract.buildDocumentUriUsingTree(tree, id).toString() to name)
        }
      }
    }
  }
}
