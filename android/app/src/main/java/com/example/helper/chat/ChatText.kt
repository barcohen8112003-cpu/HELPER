package com.example.helper.chat

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle

// Helper writes WhatsApp formatting: *bold*, _italic_, ~strike~, `code`, lists with •. This shows it the way
// WhatsApp would. A marker only counts at the edge of a word, so snake_case and 2*3 are left alone.
private const val EDGE_BEFORE = """(?<![\p{L}\p{N}])"""
private const val EDGE_AFTER = """(?![\p{L}\p{N}])"""
private val INLINE = Regex(
    """`([^`\n]+)`|${EDGE_BEFORE}\*([^*\n]+)\*$EDGE_AFTER|${EDGE_BEFORE}_([^_\n]+)_$EDGE_AFTER|${EDGE_BEFORE}~([^~\n]+)~$EDGE_AFTER|(https?://[^\s<>"]+)"""
)

fun renderChatText(text: String, link: Color, codeBackground: Color): AnnotatedString = buildAnnotatedString {
    val lines = text.trim().lines()
    lines.forEachIndexed { index, raw ->
        val bullet = Regex("""^\s*[-*•]\s+(.*)""").matchEntire(raw)
        val line = if (bullet != null) "•  " + bullet.groupValues[1] else raw
        appendInline(line, link, codeBackground)
        if (index < lines.lastIndex) append('\n')
    }
}

private fun AnnotatedString.Builder.appendInline(line: String, link: Color, codeBackground: Color) {
    var cursor = 0
    for (m in INLINE.findAll(line)) {
        if (m.range.first > cursor) append(line.substring(cursor, m.range.first))
        val g = m.groupValues
        when {
            g[1].isNotEmpty() -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(" ${g[1]} ") }
            g[2].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(g[2]) }
            g[3].isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(g[3]) }
            g[4].isNotEmpty() -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(g[4]) }
            else -> {
                // Trailing punctuation belongs to the sentence, not to the address.
                val url = g[5].trimEnd('.', ',', ')', '!', '?', ';', ':')
                withStyle(SpanStyle(color = link, textDecoration = TextDecoration.Underline)) { append(url) }
                append(g[5].substring(url.length))
            }
        }
        cursor = m.range.last + 1
    }
    if (cursor < line.length) append(line.substring(cursor))
}

/** The address of the first link in [text], for opening it. */
fun firstLink(text: String): String? =
    Regex("""https?://[^\s<>"]+""").find(text)?.value?.trimEnd('.', ',', ')', '!', '?', ';', ':')
