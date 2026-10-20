package com.example.helper.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class UpdaterTest {
    private val hash = "a".repeat(64)
    private val good = """{"versionCode":142,"versionName":"1.42","sha256":"${hash.uppercase()}","url":"https://github.com/x/y/releases/download/android-latest/HELPER.apk"}"""

    @Test fun readsTheManifest() {
        val r = Updater.parse(good)!!
        assertEquals(142, r.versionCode)
        assertEquals("1.42", r.versionName)
        assertEquals(hash, r.sha256)
    }

    @Test fun refusesABadManifest() {
        assertNull(Updater.parse("not json"))
        assertNull(Updater.parse(good.replace("https://", "http://")))
        assertNull(Updater.parse(good.replace(hash.uppercase(), "1234")))
        assertNull(Updater.parse("""{"versionCode":5}"""))
    }

    @Test fun onlyNewerVersionsInstall() {
        val r = Updater.parse(good)!!
        assertTrue(Updater.isNewer(r, 1))
        assertFalse(Updater.isNewer(r, 142))
        assertFalse(Updater.isNewer(r, 150))
    }

    @Test fun hashesAFile() {
        val f = File.createTempFile("helper", ".bin").apply { writeText("abc"); deleteOnExit() }
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", Updater.sha256(f))
    }
}
