package com.example.helper.phone

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.example.helper.update.Updater
import com.google.gson.JsonObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import kotlin.coroutines.resume

/**
 * HELPER's hands on the phone. The server's goal loop asks it to observe (a numbered list of what is on screen, and a
 * screenshot when asked) and to act once; it answers after the screen has settled. It decides nothing by itself.
 *
 * It also refuses, whatever the server says, to type into a password or code field or to type a card number.
 */
class HelperAccessibilityService : AccessibilityService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var link: PhoneLink
    private lateinit var bubble: Bubble
    private var lastNodes: List<UiNode> = emptyList()
    @Volatile private var lastEventAt = 0L

    override fun onServiceConnected() {
        instance = this
        bubble = Bubble(this) { link.send(mapOf("type" to "stop")) }
        link = PhoneLink(this) { msg -> scope.launch { handle(msg) } }
        link.start()
        PhoneAgentService.start(this)
        // This service is the part of the app Android keeps running, so it is where updates are checked.
        scope.launch {
            delay(60_000)
            while (true) {
                Updater.check(this@HelperAccessibilityService, busy)
                delay(6 * 3600_000L)
            }
        }
    }

    /** A phone task is running (the bubble is up); an update would restart the app under it. */
    @Volatile var busy = false
        private set

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.packageName == packageName) return
        lastEventAt = SystemClock.uptimeMillis()
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        if (::link.isInitialized) link.stop()
        if (::bubble.isInitialized) bubble.remove()
        PhoneAgentService.stop(this)
        scope.cancel()
        super.onDestroy()
    }

    /** "Stop" from the persistent notification. */
    fun requestStop() {
        link.send(mapOf("type" to "stop"))
        bubble.finish("עוצר…")
    }

    // ---- the protocol ----

    private suspend fun handle(msg: JsonObject) {
        val op = msg.get("op")?.asString ?: return
        if (op == "status" || op == "finish") {
            val text = msg.get("text")?.asString.orEmpty()
            busy = op == "status"
            if (op == "status") bubble.show(text) else bubble.finish(text)
            return
        }
        val id = msg.get("id")?.asInt ?: return
        val args = msg.get("args")?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()
        try {
            val result: Map<String, Any?> = when (op) {
                "observe" -> observe(args.get("image")?.asBoolean == true)
                "capture" -> mapOf("image" to screenshot())
                "act" -> act(PhoneAction.parse(args))
                else -> throw IllegalArgumentException("לא מוכר: $op")
            }
            link.send(mapOf("id" to id, "ok" to true, "result" to result))
        } catch (e: Exception) {
            link.send(mapOf("id" to id, "ok" to false, "error" to (e.message ?: e.javaClass.simpleName)))
        }
    }

    private fun screenSize(): Pair<Int, Int> {
        val m = resources.displayMetrics
        if (Build.VERSION.SDK_INT >= 30) {
            val b = getSystemService(android.view.WindowManager::class.java).currentWindowMetrics.bounds
            return b.width() to b.height()
        }
        return m.widthPixels to m.heightPixels
    }

    /** Windows the user can see, top first, leaving out the keyboard and HELPER's own bubble. */
    private fun roots(): List<AccessibilityNodeInfo> {
        val list = windows.orEmpty()
            .filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION || it.type == AccessibilityWindowInfo.TYPE_SYSTEM }
            .sortedByDescending { it.layer }
            .mapNotNull { it.root }
            .filter { it.packageName != packageName }
        return list.ifEmpty { listOfNotNull(rootInActiveWindow) }
    }

    private suspend fun observe(withImage: Boolean): Map<String, Any?> {
        val (w, h) = screenSize()
        val roots = roots()
        lastNodes = ScreenTree.flatten(roots.map { AccessNode(it) }, w, h)
        return buildMap {
            put("pkg", rootInActiveWindow?.packageName?.toString() ?: roots.firstOrNull()?.packageName?.toString().orEmpty())
            put("width", w)
            put("height", h)
            put("nodes", lastNodes.map { it.toMap() })
            if (withImage) put("image", screenshot())
        }
    }

    private fun node(index: Int?) = index?.let { i -> lastNodes.firstOrNull { it.i == i } ?: throw IllegalArgumentException("אין רכיב [$i] במסך האחרון") }

    private suspend fun act(a: PhoneAction): Map<String, Any?> {
        var info = ""
        when (a) {
            is PhoneAction.Tap -> tap(a.index, a.x, a.y, long = false)
            is PhoneAction.LongPress -> tap(a.index, a.x, a.y, long = true)
            is PhoneAction.Type -> type(a)
            is PhoneAction.Scroll -> scroll(a)
            is PhoneAction.Swipe -> {
                val (w, h) = screenSize()
                val s = PhoneSafety.swipeFor(a.direction, w, h)
                gesture(s[0], s[1], s[2], s[3], 300)
            }
            is PhoneAction.Key -> key(a.key)
            is PhoneAction.OpenApp -> info = Shortcuts.openApp(this, a.pkg, a.name)
            is PhoneAction.Launch -> info = Shortcuts.launch(this, a.kind, a.args)
            is PhoneAction.Device -> info = Shortcuts.device(this, a.setting, a.value)
            is PhoneAction.Copy -> getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("HELPER", a.text))
            is PhoneAction.Paste -> target(a.index).performAction(AccessibilityNodeInfo.ACTION_PASTE)
            PhoneAction.Notifications -> info = HelperNotificationListener.recent(this)
        }
        settle()
        return mapOf("ok" to true, "info" to info.ifEmpty { null })
    }

    private suspend fun tap(index: Int?, x: Int?, y: Int?, long: Boolean) {
        val n = node(index)
        val action = if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
        // The element itself, then the nearest ancestor that takes the click; a plain gesture when neither does.
        var info = (n?.source as? AccessNode)?.info?.takeIf { it.refresh() }
        while (info != null) {
            if ((if (long) info.isLongClickable else info.isClickable) && info.performAction(action)) return
            info = info.parent
        }
        val px = n?.x ?: x ?: throw IllegalArgumentException("חסר יעד")
        val py = n?.y ?: y ?: throw IllegalArgumentException("חסר יעד")
        if (!gesture(px, py, px, py, if (long) 700 else 60)) throw IllegalStateException("הלחיצה לא נקלטה")
    }

    /** The field to type into: the one named, or the focused input. Never a secret one. */
    private fun target(index: Int?): AccessibilityNodeInfo {
        val n = node(index)
        if (PhoneSafety.isSecretField(n)) throw SecurityException("שדה סיסמה או קוד: את זה המשתמש מקליד בעצמו")
        val info = (n?.source as? AccessNode)?.info?.takeIf { it.refresh() }
            ?: findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            ?: throw IllegalStateException("אין שדה טקסט בפוקוס")
        if (info.isPassword) throw SecurityException("שדה סיסמה: את זה המשתמש מקליד בעצמו")
        return info
    }

    private fun type(a: PhoneAction.Type) {
        if (PhoneSafety.looksLikeCard(a.text)) throw SecurityException("זה נראה כמו מספר כרטיס. פרטי תשלום לא מוקלדים")
        val field = target(a.index)
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, a.text) }
        if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw IllegalStateException("השדה לא קיבל טקסט")
    }

    private suspend fun scroll(a: PhoneAction.Scroll) {
        val forward = a.direction == "down" || a.direction == "right"
        val chosen = node(a.index) ?: lastNodes.firstOrNull { it.scrollable }
        val info = (chosen?.source as? AccessNode)?.info?.takeIf { it.refresh() }
        val action = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        if (info != null && info.performAction(action)) return
        val (w, h) = screenSize()
        val s = PhoneSafety.swipeFor(a.direction, w, h)
        gesture(s[0], s[1], s[2], s[3], 300)
    }

    private fun key(k: String) {
        val ok = when (k) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "quick_settings" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            "enter" -> Build.VERSION.SDK_INT >= 30 &&
                findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id) == true
            else -> false
        }
        if (!ok) throw IllegalStateException("המקש $k לא נלחץ")
    }

    private suspend fun gesture(x1: Int, y1: Int, x2: Int, y2: Int, ms: Long): Boolean = suspendCancellableCoroutine { cont ->
        val path = Path().apply {
            moveTo(x1.toFloat(), y1.toFloat())
            lineTo(x2.toFloat(), y2.toFloat())
        }
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build()
        val sent = dispatchGesture(g, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) = cont.resume(true)
            override fun onCancelled(gestureDescription: GestureDescription?) = cont.resume(false)
        }, null)
        if (!sent) cont.resume(false)
    }

    /** Waits until the screen has been quiet for 300 ms (at most 3 s), instead of a fixed pause. */
    private suspend fun settle() {
        val start = SystemClock.uptimeMillis()
        delay(120)
        while (SystemClock.uptimeMillis() - start < 3000) {
            if (SystemClock.uptimeMillis() - lastEventAt >= 300) return
            delay(60)
        }
    }

    /** JPEG, at most 720 px wide, base64. Empty on Android older than 11 or on a protected screen. */
    private suspend fun screenshot(): String {
        if (Build.VERSION.SDK_INT < 30) return ""
        return suspendCancellableCoroutine { cont ->
            takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                    result.hardwareBuffer.close()
                    if (hw == null) return cont.resume("")
                    val soft = hw.copy(Bitmap.Config.ARGB_8888, false)
                    hw.recycle()
                    val scale = 720f / soft.width
                    val small = if (scale < 1f) Bitmap.createScaledBitmap(soft, 720, (soft.height * scale).toInt(), true) else soft
                    val out = ByteArrayOutputStream()
                    small.compress(Bitmap.CompressFormat.JPEG, 60, out)
                    if (small !== soft) soft.recycle()
                    small.recycle()
                    cont.resume(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
                }

                override fun onFailure(errorCode: Int) = cont.resume("")
            })
        }
    }

    companion object {
        @Volatile
        var instance: HelperAccessibilityService? = null
            private set
    }
}

/** AccessibilityNodeInfo seen through [TreeNode], so the flattening logic stays testable without a phone. */
class AccessNode(val info: AccessibilityNodeInfo) : TreeNode {
    private val rect = Rect().also { info.getBoundsInScreen(it) }
    override val text get() = info.text?.toString()
    override val desc get() = info.contentDescription?.toString()
    override val hint get() = if (Build.VERSION.SDK_INT >= 26) info.hintText?.toString() else null
    override val viewId get() = info.viewIdResourceName
    override val className get() = info.className?.toString()
    override val clickable get() = info.isClickable
    override val editable get() = info.isEditable
    override val scrollable get() = info.isScrollable
    override val checkable get() = info.isCheckable
    override val checked get() = info.isChecked
    override val selected get() = info.isSelected
    override val focused get() = info.isFocused
    override val password get() = info.isPassword
    override val enabled get() = info.isEnabled
    override val visible get() = info.isVisibleToUser
    override val left get() = rect.left
    override val top get() = rect.top
    override val right get() = rect.right
    override val bottom get() = rect.bottom
    override val children: List<TreeNode> get() = (0 until info.childCount).mapNotNull { info.getChild(it)?.let(::AccessNode) }
}
