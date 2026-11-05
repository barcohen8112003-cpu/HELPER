package com.example.helper.wake

import android.content.Context
import android.net.Uri
import java.io.File

/** Keyword (.ppn) and optional language model (.pv) the owner imports. Nothing is bundled. */
object WakeFiles {
    fun keyword(context: Context): File? = file(context, "keyword.ppn")
    fun model(context: Context): File? = file(context, "model.pv")

    fun save(context: Context, uri: Uri, name: String): File {
        val dir = File(context.filesDir, "wake").apply { mkdirs() }
        val out = File(dir, name)
        context.contentResolver.openInputStream(uri).use { input ->
            requireNotNull(input) { "לא הצלחתי לקרוא את הקובץ" }
            out.outputStream().use { input.copyTo(it) }
        }
        return out
    }

    fun clear(context: Context, name: String) {
        File(context.filesDir, "wake/$name").delete()
    }

    private fun file(context: Context, name: String): File? =
        File(context.filesDir, "wake/$name").takeIf { it.isFile && it.length() > 32 }
}
