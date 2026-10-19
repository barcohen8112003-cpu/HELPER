package com.example.helper.wake

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WakePhraseTest {
    @Test
    fun hearsTheWakePhrase() {
        listOf(
            "היי בוט", "הי בוט", "היי, בוט", "היי בוט.", "אי בוט", "hey bot", "Hey Bot!", "הייבוט", "היבוט",
            "בוט", "היי בוט מה השעה", "היי הבוט", "hi boat"
        ).forEach { assertTrue(it, WakePhrase.matches(it)) }
    }

    @Test
    fun ignoresOrdinarySpeech() {
        listOf(
            "", "היי", "הבוט לא עובד", "תגיד לבוט משהו", "but why", "but", "שלום מה נשמע", "היי בוקר טוב"
        ).forEach { assertFalse(it, WakePhrase.matches(it)) }
    }
}
