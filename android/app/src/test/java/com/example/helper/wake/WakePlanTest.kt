package com.example.helper.wake

import org.junit.Assert.assertEquals
import org.junit.Test

class WakePlanTest {
    @Test
    fun staysOfflineWithoutAKey() {
        val choice = chooseWake("", hasKeyword = true, hasModel = true, jarvis = true)
        assertEquals(WakeEngine.OFFLINE, choice.engine)
    }

    @Test
    fun porcupineWithACustomKeyword() {
        val choice = chooseWake("key", hasKeyword = true, hasModel = false, jarvis = false)
        assertEquals(WakeEngine.PORCUPINE, choice.engine)
        assertEquals(true, choice.customKeyword)
    }

    @Test
    fun jarvisWhenThereIsNoHebrewModel() {
        val choice = chooseWake("key", hasKeyword = false, hasModel = false, jarvis = true)
        assertEquals(WakeEngine.PORCUPINE, choice.engine)
        assertEquals(true, choice.jarvis)
    }

    @Test
    fun hebrewModelDoesNotAlsoListenForJarvis() {
        val choice = chooseWake("key", hasKeyword = true, hasModel = true, jarvis = true)
        assertEquals(WakeEngine.PORCUPINE, choice.engine)
        assertEquals(false, choice.jarvis)
        assertEquals(true, choice.customModel)
    }

    @Test
    fun aKeyAloneIsNotEnough() {
        val choice = chooseWake("key", hasKeyword = false, hasModel = false, jarvis = false)
        assertEquals(WakeEngine.OFFLINE, choice.engine)
    }
}
