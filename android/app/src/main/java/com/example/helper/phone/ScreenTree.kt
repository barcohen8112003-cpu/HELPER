package com.example.helper.phone

/**
 * The screen as the server's model reads it: a short numbered list of what can be seen or touched, instead of a
 * screenshot every step. Kept free of Android types so it can be unit tested; the accessibility service adapts
 * AccessibilityNodeInfo to [TreeNode].
 */
interface TreeNode {
    val text: String?
    val desc: String?
    val hint: String?
    val viewId: String?
    val className: String?
    val clickable: Boolean
    val editable: Boolean
    val scrollable: Boolean
    val checkable: Boolean
    val checked: Boolean
    val selected: Boolean
    val focused: Boolean
    val password: Boolean
    val enabled: Boolean
    val visible: Boolean
    val left: Int
    val top: Int
    val right: Int
    val bottom: Int
    val children: List<TreeNode>
}

data class UiNode(
    val i: Int,
    val role: String,
    val text: String,
    val desc: String,
    val hint: String,
    val id: String,
    val clickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val checked: Boolean,
    val selected: Boolean,
    val focused: Boolean,
    val password: Boolean,
    val disabled: Boolean,
    val left: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
    /** The node it came from, so an action can be performed on it. Not sent to the server. */
    @Transient val source: TreeNode? = null,
) {
    val x get() = (left + right) / 2
    val y get() = (top + bottom) / 2

    /** The wire shape: only flags that are set, to keep each step small. */
    fun toMap(): Map<String, Any> = buildMap {
        put("i", i)
        put("role", role)
        if (text.isNotEmpty()) put("text", text)
        if (desc.isNotEmpty()) put("desc", desc)
        if (hint.isNotEmpty()) put("hint", hint)
        if (id.isNotEmpty()) put("id", id)
        if (clickable) put("clickable", true)
        if (editable) put("editable", true)
        if (scrollable) put("scrollable", true)
        if (checked) put("checked", true)
        if (selected) put("selected", true)
        if (focused) put("focused", true)
        if (password) put("password", true)
        if (disabled) put("disabled", true)
        put("x", x)
        put("y", y)
        put("b", listOf(left, top, right, bottom))
    }
}

object ScreenTree {
    const val LIMIT = 150
    private const val MAX_LABEL = 100

    /** "android.widget.Button" -> "Button"; Compose and custom views fall back to their last name segment. */
    fun role(className: String?): String {
        val name = className?.substringAfterLast('.')?.takeIf { it.isNotBlank() } ?: return "View"
        return when (name) {
            "AppCompatButton", "MaterialButton" -> "Button"
            "AppCompatEditText", "TextInputEditText", "AutoCompleteTextView" -> "EditText"
            "AppCompatTextView", "MaterialTextView" -> "TextView"
            "AppCompatImageView", "AppCompatImageButton" -> "Image"
            "RecyclerView", "ListView", "ScrollView", "NestedScrollView", "HorizontalScrollView" -> "List"
            else -> name
        }
    }

    private fun clean(s: String?) = s?.replace(Regex("\\s+"), " ")?.trim().orEmpty()

    /** "com.wolt.android:id/search_button" -> "search_button". */
    private fun shortId(id: String?) = id?.substringAfter(":id/", id).orEmpty()

    /**
     * Visible elements in reading order: anything that can be touched, typed into or scrolled, and any text.
     * A tappable container with no text of its own (a card, a list row) is labelled with the text inside it, and
     * that inner text is not listed again, so "[4] Button "Pizza Hut 4.6 ★"" is one line, not three.
     */
    fun flatten(roots: List<TreeNode>, screenWidth: Int, screenHeight: Int, limit: Int = LIMIT): List<UiNode> {
        val out = ArrayList<UiNode>()
        fun onScreen(n: TreeNode) =
            n.visible && n.right > n.left && n.bottom > n.top &&
                n.right > 0 && n.bottom > 0 && n.left < screenWidth && n.top < screenHeight

        fun innerText(n: TreeNode, sb: StringBuilder) {
            if (sb.length >= MAX_LABEL) return
            val t = clean(n.text).ifEmpty { clean(n.desc) }
            if (t.isNotEmpty()) {
                if (sb.isNotEmpty()) sb.append(' ')
                sb.append(t)
            }
            n.children.forEach { innerText(it, sb) }
        }

        fun visit(n: TreeNode, labelled: Boolean) {
            if (out.size >= limit || !onScreen(n)) return
            val interactive = n.clickable || n.editable || n.scrollable || n.checkable
            var text = clean(n.text)
            val desc = clean(n.desc)
            var childrenLabelled = labelled
            if (n.clickable && !n.editable && text.isEmpty() && desc.isEmpty()) {
                val sb = StringBuilder()
                n.children.forEach { innerText(it, sb) }
                text = sb.toString().take(MAX_LABEL)
                if (text.isNotEmpty()) childrenLabelled = true
            }
            val worthListing = interactive || ((text.isNotEmpty() || desc.isNotEmpty()) && !labelled)
            if (worthListing) {
                out += UiNode(
                    i = out.size + 1,
                    role = role(n.className),
                    // A password field's text is never read out, even masked.
                    text = if (n.password) "" else text.take(MAX_LABEL),
                    desc = desc.take(60),
                    hint = clean(n.hint).take(40),
                    id = shortId(n.viewId),
                    clickable = n.clickable,
                    editable = n.editable,
                    scrollable = n.scrollable,
                    checked = n.checked,
                    selected = n.selected,
                    focused = n.focused,
                    password = n.password,
                    disabled = !n.enabled,
                    left = n.left.coerceAtLeast(0),
                    top = n.top.coerceAtLeast(0),
                    right = n.right.coerceAtMost(screenWidth),
                    bottom = n.bottom.coerceAtMost(screenHeight),
                    source = n,
                )
            }
            n.children.forEach { visit(it, childrenLabelled) }
        }
        roots.forEach { visit(it, false) }
        return out
    }
}
