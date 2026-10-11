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

@InvokeArg
class TreeDocumentArgs {
  lateinit var tree: String
  lateinit var name: String
  lateinit var mime: String
}

@InvokeArg
class CreateDocumentArgs {
  lateinit var name: String
  lateinit var mime: String
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

  /** Opens the system "save as" screen; the callback returns a writable descriptor. */
  @Command
  fun createDocument(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(CreateDocumentArgs::class.java)
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
        .addCategory(Intent.CATEGORY_OPENABLE)
        .setType(args.mime)
        .putExtra(Intent.EXTRA_TITLE, args.name)
      startActivityForResult(invoke, intent, "documentCreated")
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The save screen cannot be opened")
    }
  }

  @ActivityCallback
  fun documentCreated(invoke: Invoke, result: ActivityResult) {
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      invoke.resolve(JSObject())
      return
    }
    try {
      val descriptor = activity.contentResolver.openFileDescriptor(uri, "wt")
        ?: throw IllegalStateException("The document provider returned no file")
      invoke.resolve(JSObject().put("fd", descriptor.detachFd()))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The document cannot be written")
    }
  }

  /** Picks a folder for backups and keeps read and write access to it. */
  @Command
  fun pickWritableFolder(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
      )
      startActivityForResult(invoke, intent, "writableFolderPicked")
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The folder picker cannot be opened")
    }
  }

  @ActivityCallback
  fun writableFolderPicked(invoke: Invoke, result: ActivityResult) {
    val tree = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || tree == null) {
      invoke.resolve(JSObject())
      return
    }
    try {
      activity.contentResolver.takePersistableUriPermission(
        tree,
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
      )
      val folder = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
      var name: String? = null
      activity.contentResolver.query(folder, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
        ?.use { cursor -> if (cursor.moveToFirst()) name = cursor.getString(0) }
      invoke.resolve(JSObject().put("uri", tree.toString()).put("name", name ?: tree.lastPathSegment))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The folder cannot be used")
    }
  }

  /** Opens `name` in a granted folder for writing, creating or replacing it. */
  @Command
  fun openTreeDocument(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(TreeDocumentArgs::class.java)
      val tree = Uri.parse(args.tree)
      val parent = DocumentsContract.getTreeDocumentId(tree)
      val resolver = activity.contentResolver
      var existing: Uri? = null
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
      resolver.query(
        children,
        arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
        null, null, null,
      )?.use { cursor ->
        while (cursor.moveToNext()) {
          if (cursor.getString(1) == args.name) {
            existing = DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(0))
            break
          }
        }
      }
      val target = existing ?: DocumentsContract.createDocument(
        resolver,
        DocumentsContract.buildDocumentUriUsingTree(tree, parent),
        args.mime,
        args.name,
      ) ?: throw IllegalStateException("The backup file cannot be created")
      val descriptor = resolver.openFileDescriptor(target, "wt")
        ?: throw IllegalStateException("The document provider returned no file")
      invoke.resolve(JSObject().put("fd", descriptor.detachFd()))
    } catch (error: Exception) {
      invoke.reject(error.message ?: "The backup folder cannot be written")
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
