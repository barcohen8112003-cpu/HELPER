package com.example.helper.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * What the phone remembers about the HELPER server: the address and bridge token from the QR, whether chat replies
 * are read aloud, and whether the wake word stays on. Encrypted, since the token lets anyone talk to the assistant.
 * The server's data/ directory is a different folder and is not this package.
 */
class SettingsRepository(context: Context) {

    private val sharedPreferences: SharedPreferences

    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        sharedPreferences = EncryptedSharedPreferences.create(
            context,
            "helper_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun saveConnectionDetails(url: String, token: String) {
        sharedPreferences.edit()
            .putString(KEY_URL, url)
            .putString(KEY_TOKEN, token)
            .apply()
    }

    fun getUrl(): String? = sharedPreferences.getString(KEY_URL, null)

    fun getToken(): String? = sharedPreferences.getString(KEY_TOKEN, null)

    fun hasConnectionDetails(): Boolean {
        return getUrl() != null && getToken() != null
    }

    fun isWakeWordEnabled(): Boolean = sharedPreferences.getBoolean(KEY_WAKE_WORD, false)

    fun setWakeWordEnabled(enabled: Boolean) {
        sharedPreferences.edit().putBoolean(KEY_WAKE_WORD, enabled).apply()
    }

    /** Whether the chat reads Helper's answers aloud. On by default; the speaker button in the chat turns it off. */
    fun isChatSpeakEnabled(): Boolean = sharedPreferences.getBoolean(KEY_CHAT_SPEAK, true)

    fun setChatSpeakEnabled(enabled: Boolean) {
        sharedPreferences.edit().putBoolean(KEY_CHAT_SPEAK, enabled).apply()
    }

    /** On-device "היי הלפר". Off until the owner turns it on. */
    fun isDeviceWakeEnabled(): Boolean = sharedPreferences.getBoolean(KEY_DEVICE_WAKE, false)

    fun setDeviceWakeEnabled(enabled: Boolean) {
        sharedPreferences.edit().putBoolean(KEY_DEVICE_WAKE, enabled).apply()
    }

    fun porcupineKey(): String = sharedPreferences.getString(KEY_PICOVOICE, "").orEmpty()

    fun setPorcupineKey(key: String) {
        sharedPreferences.edit().putString(KEY_PICOVOICE, key.trim()).apply()
    }

    /** Built-in English "Jarvis" keyword. Still needs a Picovoice AccessKey. */
    fun jarvisWake(): Boolean = sharedPreferences.getBoolean(KEY_JARVIS, false)

    fun setJarvisWake(enabled: Boolean) {
        sharedPreferences.edit().putBoolean(KEY_JARVIS, enabled).apply()
    }

    fun clearConnectionDetails() {
        sharedPreferences.edit()
            .remove(KEY_URL)
            .remove(KEY_TOKEN)
            .apply()
    }

    companion object {
        private const val KEY_URL = "connection_url"
        private const val KEY_TOKEN = "connection_token"
        private const val KEY_WAKE_WORD = "wake_word_enabled"
        private const val KEY_CHAT_SPEAK = "chat_speak_enabled"
        private const val KEY_DEVICE_WAKE = "device_wake_enabled"
        private const val KEY_PICOVOICE = "picovoice_access_key"
        private const val KEY_JARVIS = "wake_jarvis"

        @Volatile
        private var INSTANCE: SettingsRepository? = null

        fun getInstance(context: Context): SettingsRepository {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: SettingsRepository(context.applicationContext).also { INSTANCE = it }
            }
        }
    }
}
