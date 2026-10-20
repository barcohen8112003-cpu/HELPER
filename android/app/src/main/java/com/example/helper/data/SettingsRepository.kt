package com.example.helper.data

import android.content.Context

/**
 * What the phone remembers about the HELPER server: the address and bridge token from the QR, whether chat replies
 * are read aloud, and whether the wake word stays on. Plain SharedPreferences. The server's data/ directory is a
 * different folder and is not this package.
 */
class SettingsRepository private constructor(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun getUrl(): String? = prefs.getString(KEY_URL, null)

    fun getToken(): String? = prefs.getString(KEY_TOKEN, null)

    fun saveConnectionDetails(url: String, token: String) {
        prefs.edit().putString(KEY_URL, url).putString(KEY_TOKEN, token).apply()
    }

    fun hasConnectionDetails(): Boolean = !getUrl().isNullOrBlank() && !getToken().isNullOrBlank()

    /** Spoken answers are on until the user mutes them. */
    fun isChatSpeakEnabled(): Boolean = prefs.getBoolean(KEY_CHAT_SPEAK, true)

    fun setChatSpeakEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_CHAT_SPEAK, enabled).apply()
    }

    fun isWakeWordEnabled(): Boolean = prefs.getBoolean(KEY_WAKE, false)

    fun setWakeWordEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_WAKE, enabled).apply()
    }

    companion object {
        private const val PREFS = "helper_settings"
        private const val KEY_URL = "url"
        private const val KEY_TOKEN = "token"
        private const val KEY_CHAT_SPEAK = "chat_speak"
        private const val KEY_WAKE = "wake_word"

        @Volatile
        private var instance: SettingsRepository? = null

        fun getInstance(context: Context): SettingsRepository {
            return instance ?: synchronized(this) {
                instance ?: SettingsRepository(context.applicationContext).also { instance = it }
            }
        }
    }
}
