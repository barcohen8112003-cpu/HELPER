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

        @Volatile
        private var INSTANCE: SettingsRepository? = null

        fun getInstance(context: Context): SettingsRepository {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: SettingsRepository(context.applicationContext).also { INSTANCE = it }
            }
        }
    }
}
