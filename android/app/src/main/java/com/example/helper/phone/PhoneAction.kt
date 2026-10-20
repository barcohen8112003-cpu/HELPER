package com.example.helper.phone

import com.google.gson.JsonObject

/** One action from the server's goal loop, parsed and checked before anything touches the phone. */
sealed class PhoneAction {
    data class Tap(val index: Int?, val x: Int?, val y: Int?) : PhoneAction()
    data class LongPress(val index: Int?, val x: Int?, val y: Int?) : PhoneAction()
    data class Type(val text: String, val index: Int?) : PhoneAction()
    data class Scroll(val direction: String, val index: Int?) : PhoneAction()
    data class Swipe(val direction: String) : PhoneAction()
    data class Key(val key: String) : PhoneAction()
    data class OpenApp(val pkg: String?, val name: String?) : PhoneAction()
    data class Launch(val kind: String, val args: Map<String, String>) : PhoneAction()
    data class Device(val setting: String, val value: String) : PhoneAction()
    data class Copy(val text: String) : PhoneAction()
    data class Paste(val index: Int?) : PhoneAction()
    object Notifications : PhoneAction()

    companion object {
        val DIRECTIONS = setOf("up", "down", "left", "right")
        val KEYS = setOf("back", "home", "recents", "enter", "notifications", "quick_settings")
        val INTENTS = setOf("alarm", "timer", "calendar", "contact", "dial", "sms", "whatsapp", "navigate", "url", "camera", "settings")

        private fun JsonObject.str(k: String) = get(k)?.takeIf { !it.isJsonNull }?.asString?.trim()
        private fun JsonObject.int(k: String) = get(k)?.takeIf { !it.isJsonNull }?.let { runCatching { it.asDouble.toInt() }.getOrNull() }

        fun parse(o: JsonObject): PhoneAction {
            val type = o.str("type") ?: throw IllegalArgumentException("פעולה בלי סוג")
            fun pointed(): Triple<Int?, Int?, Int?> {
                val index = o.int("index")
                val x = o.int("x")
                val y = o.int("y")
                require(index != null || (x != null && y != null)) { "חסר index או x,y" }
                return Triple(index, x, y)
            }
            fun direction(): String {
                val d = o.str("direction")?.lowercase() ?: "down"
                require(d in DIRECTIONS) { "כיוון לא מוכר: $d" }
                return d
            }
            return when (type) {
                "tap", "click" -> pointed().let { (i, x, y) -> Tap(i, x, y) }
                "long_press" -> pointed().let { (i, x, y) -> LongPress(i, x, y) }
                "type" -> Type(o.str("text") ?: throw IllegalArgumentException("חסר טקסט"), o.int("index"))
                "scroll" -> Scroll(direction(), o.int("index"))
                "swipe" -> Swipe(direction())
                "key" -> {
                    val k = (o.str("keys") ?: o.str("key"))?.lowercase() ?: throw IllegalArgumentException("חסר מקש")
                    require(k in KEYS) { "מקש לא מוכר: $k" }
                    Key(k)
                }
                "open_app" -> {
                    val pkg = o.str("package")
                    val name = o.str("name")
                    require(!pkg.isNullOrEmpty() || !name.isNullOrEmpty()) { "חסר package או name" }
                    OpenApp(pkg, name)
                }
                "intent" -> {
                    val kind = o.str("kind")?.lowercase() ?: throw IllegalArgumentException("חסר kind")
                    require(kind in INTENTS) { "קיצור לא מוכר: $kind" }
                    val args = o.entrySet()
                        .filter { (k, v) -> k != "type" && k != "kind" && v.isJsonPrimitive }
                        .associate { (k, v) -> k to v.asString }
                    Launch(kind, args)
                }
                "device" -> Device(
                    o.str("setting")?.lowercase() ?: throw IllegalArgumentException("חסר setting"),
                    o.str("value") ?: "",
                )
                "copy" -> Copy(o.str("text") ?: "")
                "paste" -> Paste(o.int("index"))
                "notifications" -> Notifications
                else -> throw IllegalArgumentException("פעולה לא מוכרת: $type")
            }
        }
    }
}

/**
 * Checks that hold on the phone whatever the server asks: no typing into secret fields, no card numbers, and the
 * direction a finger moves for a scroll.
 */
object PhoneSafety {
    private val CARD = Regex("(?:\\d[ -]?){13,19}")
    private val SECRET_HINT = Regex("passw|סיסמ|otp|one.?time|קוד אימות|קוד חד|verification code|cvv|cvc|card.?number|cc.?num|מספר כרטיס|אשראי|\\bpin\\b", RegexOption.IGNORE_CASE)

    fun looksLikeCard(text: String) = CARD.containsMatchIn(text)

    fun isSecretField(n: UiNode?) =
        n != null && (n.password || (n.editable && SECRET_HINT.containsMatchIn("${n.hint} ${n.id} ${n.desc}")))

    /** Where the finger goes to scroll the content [direction]: content moves down when the finger moves up. */
    fun swipeFor(direction: String, w: Int, h: Int): IntArray {
        val cx = w / 2
        val cy = h / 2
        val dy = (h * 0.30).toInt()
        val dx = (w * 0.35).toInt()
        return when (direction) {
            "down" -> intArrayOf(cx, cy + dy, cx, cy - dy)
            "up" -> intArrayOf(cx, cy - dy, cx, cy + dy)
            "right" -> intArrayOf(cx + dx, cy, cx - dx, cy)
            else -> intArrayOf(cx - dx, cy, cx + dx, cy)
        }
    }
}
