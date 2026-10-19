package com.example.helper.network

import com.example.helper.data.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class HelperResponse(
    val reply: String,
    val audio: String?
)

class HelperApiService(private val settingsRepository: SettingsRepository) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        // A turn runs the whole assistant (tools, browsing) and then the ElevenLabs voice, which can take minutes.
        .readTimeout(180, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    /** The spoken version of [text] in the assistant's own voice, as MP3 bytes. */
    suspend fun speech(text: String): ByteArray = withContext(Dispatchers.IO) {
        var baseUrl = settingsRepository.getUrl()?.trim() ?: throw Exception("לא הוגדרה כתובת שרת")
        val token = settingsRepository.getToken()?.trim() ?: throw Exception("לא הוגדר טוקן חיבור")
        if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) baseUrl = "http://$baseUrl"
        val request = Request.Builder()
            .url(baseUrl.removeSuffix("/") + "/bridge/tts")
            .post(JSONObject().put("text", text).toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
            .addHeader("Authorization", "Bearer $token")
            .build()
        try { client.newCall(request).execute() } catch (e: java.net.SocketTimeoutException) {
            throw Exception(timeoutMessage(e, baseUrl))
        }.use { response ->
            if (!response.isSuccessful) throw Exception("שגיאה מהשרת: ${response.code}")
            response.body?.bytes() ?: throw Exception("תשובה ריקה מהשרת")
        }
    }

    suspend fun sendMessage(text: String, voice: Boolean = false, audio: Boolean = voice): HelperResponse = withContext(Dispatchers.IO) {
        var baseUrl = settingsRepository.getUrl()?.trim() ?: throw Exception("לא הוגדרה כתובת שרת")
        val token = settingsRepository.getToken()?.trim() ?: throw Exception("לא הוגדר טוקן חיבור")

        if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
            baseUrl = "http://$baseUrl"
        }
        baseUrl = baseUrl.removeSuffix("/")

        val fullUrl = "$baseUrl/bridge/ask"

        val jsonBody = JSONObject().apply {
            put("text", text)
            put("source", "android_app")
            // A spoken conversation: the assistant answers in a sentence or two, without formatting.
            put("voice", voice)
            // Typed chat shows text only, so the server skips the paid speech synthesis.
            put("audio", audio)
        }.toString()

        val requestBody = jsonBody.toRequestBody("application/json; charset=utf-8".toMediaType())

        val request = Request.Builder()
            .url(fullUrl)
            .post(requestBody)
            .addHeader("Authorization", "Bearer $token")
            .build()

        val response = try {
            client.newCall(request).execute()
        } catch (e: java.net.SocketTimeoutException) {
            throw Exception(timeoutMessage(e, baseUrl))
        } catch (e: java.io.IOException) {
            throw Exception("אין חיבור למחשב ($baseUrl). בדוק שהמחשב דלוק, ש-HELPER רץ ושה-Tailscale מחובר בטלפון")
        }

        if (!response.isSuccessful) {
            val errBody = response.body?.string() ?: ""
            throw Exception("שגיאה מהשרת: ${response.code} $errBody")
        }

        val responseBody = try {
            response.body?.string() ?: throw Exception("תשובה ריקה מהשרת")
        } catch (e: java.net.SocketTimeoutException) {
            throw Exception(timeoutMessage(e, baseUrl))
        }
        
        try {
            val jsonResponse = JSONObject(responseBody)
            val reply = jsonResponse.getString("reply")
            val audioData = if (jsonResponse.has("audio") && !jsonResponse.isNull("audio")) {
                jsonResponse.getString("audio")
            } else null
            
            HelperResponse(reply = reply, audio = audioData)
        } catch (e: Exception) {
            throw Exception("שגיאה בפיענוח התשובה: $responseBody")
        }
    }

    /** OkHttp says only "timeout"; tell apart "cannot reach the PC" from "the bot is still working". */
    private fun timeoutMessage(e: java.net.SocketTimeoutException, baseUrl: String): String =
        if (e.message.orEmpty().contains("connect", ignoreCase = true)) {
            "לא מצליח להגיע למחשב ($baseUrl). בדוק שהמחשב דלוק ושה-Tailscale מחובר בטלפון"
        } else {
            "הבוט לא ענה אחרי 3 דקות. כנראה הבקשה כבדה או שהוא תקוע; נסה שוב או בדוק את החלון של HELPER במחשב"
        }
}
