package com.example.helper.phone

import com.google.gson.JsonParser
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A hand-built screen, so the flattening and the action rules are checked without a phone. */
private data class Fake(
    override val text: String? = null,
    override val desc: String? = null,
    override val hint: String? = null,
    override val viewId: String? = null,
    override val className: String? = "android.view.View",
    override val clickable: Boolean = false,
    override val editable: Boolean = false,
    override val scrollable: Boolean = false,
    override val checkable: Boolean = false,
    override val checked: Boolean = false,
    override val selected: Boolean = false,
    override val focused: Boolean = false,
    override val password: Boolean = false,
    override val enabled: Boolean = true,
    override val visible: Boolean = true,
    override val left: Int = 0,
    override val top: Int = 0,
    override val right: Int = 100,
    override val bottom: Int = 100,
    override val children: List<TreeNode> = emptyList(),
) : TreeNode

class ScreenTreeTest {
    private fun flatten(vararg roots: TreeNode) = ScreenTree.flatten(roots.toList(), 1080, 2400)

    @Test fun listsTextAndControlsInReadingOrder() {
        val screen = Fake(
            right = 1080, bottom = 2400,
            children = listOf(
                Fake(text = "Wolt", className = "android.widget.TextView", right = 300, bottom = 80),
                Fake(hint = "חיפוש", className = "android.widget.EditText", editable = true, top = 100, right = 1080, bottom = 200, viewId = "com.wolt.android:id/search"),
                Fake(scrollable = true, className = "androidx.recyclerview.widget.RecyclerView", top = 200, right = 1080, bottom = 2400),
            ),
        )
        val nodes = flatten(screen)
        assertEquals(listOf(1, 2, 3), nodes.map { it.i })
        assertEquals("Wolt", nodes[0].text)
        assertEquals("EditText", nodes[1].role)
        assertEquals("search", nodes[1].id)
        assertEquals("חיפוש", nodes[1].hint)
        assertEquals("List", nodes[2].role)
        assertEquals(540 to 150, nodes[1].x to nodes[1].y)
    }

    @Test fun aTappableRowTakesItsInnerTextOnce() {
        val row = Fake(
            clickable = true, className = "android.widget.LinearLayout", right = 1080, bottom = 300,
            children = listOf(Fake(text = "Pizza Hut"), Fake(text = "4.6 ★"), Fake(desc = "תמונה")),
        )
        val nodes = flatten(row)
        assertEquals(1, nodes.size)
        assertEquals("Pizza Hut 4.6 ★ תמונה", nodes[0].text)
        assertTrue(nodes[0].clickable)
    }

    @Test fun skipsWhatCannotBeSeen() {
        val nodes = flatten(
            Fake(text = "hidden", visible = false),
            Fake(text = "empty box", right = 0, bottom = 0),
            Fake(text = "off screen", left = 2000, right = 2100),
            Fake(text = "seen"),
        )
        assertEquals(listOf("seen"), nodes.map { it.text })
    }

    @Test fun neverReadsAPasswordFieldsText() {
        val n = flatten(Fake(text = "hunter2", editable = true, password = true)).single()
        assertEquals("", n.text)
        assertTrue(n.password)
        assertEquals(true, n.toMap()["password"])
        assertFalse(n.toMap().containsKey("text"))
    }

    @Test fun stopsAtTheLimit() {
        val many = Fake(right = 1080, bottom = 2400, children = List(300) { Fake(text = "item $it", top = it, bottom = it + 5) })
        assertEquals(ScreenTree.LIMIT, flatten(many).size)
    }

    @Test fun shortRoleNames() {
        assertEquals("Button", ScreenTree.role("com.google.android.material.button.MaterialButton"))
        assertEquals("View", ScreenTree.role(null))
        assertEquals("Switch", ScreenTree.role("android.widget.Switch"))
    }
}

class PhoneActionTest {
    private fun parse(json: String) = PhoneAction.parse(JsonParser.parseString(json).asJsonObject)

    @Test fun parsesEachAction() {
        assertEquals(PhoneAction.Tap(4, null, null), parse("""{"type":"tap","index":4}"""))
        assertEquals(PhoneAction.Tap(null, 10, 20), parse("""{"type":"tap","x":10.6,"y":20}"""))
        assertEquals(PhoneAction.Type("שלום", 2), parse("""{"type":"type","text":"שלום","index":2}"""))
        assertEquals(PhoneAction.Scroll("down", null), parse("""{"type":"scroll"}"""))
        assertEquals(PhoneAction.Key("back"), parse("""{"type":"key","keys":"BACK"}"""))
        assertEquals(PhoneAction.OpenApp("com.gett", null), parse("""{"type":"open_app","package":"com.gett"}"""))
        assertEquals(PhoneAction.Launch("alarm", mapOf("hour" to "7", "minute" to "0")), parse("""{"type":"intent","kind":"alarm","hour":7,"minute":0}"""))
        assertEquals(PhoneAction.Launch("alarm", mapOf("hour" to "7", "minute" to "0", "label" to "בוקר")), parse("""{"type":"intent","kind":"alarm","hour":7.0,"minute":0.0,"label":"בוקר"}"""))
        assertEquals(PhoneAction.Device("flashlight", "on"), parse("""{"type":"device","setting":"flashlight","value":"on"}"""))
        assertEquals(PhoneAction.Notifications, parse("""{"type":"notifications"}"""))
    }

    @Test fun rejectsWhatItCannotDo() {
        val bad = listOf(
            """{"type":"tap"}""",
            """{"type":"key","keys":"power"}""",
            """{"type":"intent","kind":"factory_reset"}""",
            """{"type":"swipe","direction":"sideways"}""",
            """{"type":"rm"}""",
            """{}""",
        )
        for (json in bad) {
            assertTrue(json, runCatching { parse(json) }.isFailure)
        }
    }
}

class PhoneSafetyTest {
    private fun node(hint: String = "", password: Boolean = false, id: String = "") =
        UiNode(1, "EditText", "", "", hint, id, false, true, false, false, false, true, password, false, 0, 0, 10, 10)

    @Test fun secretFields() {
        assertTrue(PhoneSafety.isSecretField(node(password = true)))
        assertTrue(PhoneSafety.isSecretField(node(hint = "סיסמה")))
        assertTrue(PhoneSafety.isSecretField(node(hint = "Enter the verification code")))
        assertTrue(PhoneSafety.isSecretField(node(id = "card_number")))
        assertFalse(PhoneSafety.isSecretField(node(hint = "חיפוש")))
        assertFalse(PhoneSafety.isSecretField(null))
    }

    @Test fun cardNumbers() {
        assertTrue(PhoneSafety.looksLikeCard("4580 1234 5678 9012"))
        assertFalse(PhoneSafety.looksLikeCard("050-1234567"))
        assertFalse(PhoneSafety.looksLikeCard("אני בדרך"))
    }

    @Test fun scrollDownMovesTheFingerUp() {
        val s = PhoneSafety.swipeFor("down", 1000, 2000)
        assertArrayEquals(intArrayOf(500, 1600, 500, 400), s)
    }
}
