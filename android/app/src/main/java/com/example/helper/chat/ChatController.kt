package com.example.helper.chat

import android.content.Context
import android.util.Log
import com.example.helper.network.HelperApiService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class ChatMessage(
    val id: Long,
    val fromUser: Boolean,
    val text: String,
    val time: Long,
    /** The send did not go through; the message can be sent again. */
    val failed: Boolean = false
)

/**
 * The conversation shown in the chat screen. It lives for as long as the app process does (so a rotation or a trip to
 * the voice screen does not interrupt a reply that is on its way) and is saved to a private file, so the history is
 * still there tomorrow. Voice exchanges are added too: one conversation, however you talk.
 */
class ChatController private constructor(context: Context) {

    private val app = context.applicationContext
    private val file = File(app.filesDir, "chat.json")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _messages = MutableStateFlow(load())
    val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()
    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending.asStateFlow()
    private var job: Job? = null

    /** Ask the server for the answer in the assistant's voice too. Set by the chat screen from the user's choice. */
    @Volatile
    var wantAudio: Boolean = false

    /** Called with each answer that arrived, and its audio if it was requested. Not called for errors. */
    var onAnswer: ((reply: String, audio: String?) -> Unit)? = null
    private var nextId = (_messages.value.maxOfOrNull { it.id } ?: 0L) + 1

    /** Sends [text] as the user and appends the answer. Only one request at a time. */
    fun send(text: String, api: HelperApiService) {
        val clean = text.trim()
        if (clean.isEmpty() || _sending.value) return
        val message = ChatMessage(nextId++, true, clean, System.currentTimeMillis())
        _messages.update { it + message }
        save()
        ask(message, api)
    }

    fun retry(id: Long, api: HelperApiService) {
        val message = _messages.value.find { it.id == id && it.failed } ?: return
        if (_sending.value) return
        _messages.update { list -> list.map { if (it.id == id) it.copy(failed = false) else it } }
        ask(message, api)
    }

    private fun ask(message: ChatMessage, api: HelperApiService) {
        _sending.value = true
        job = scope.launch {
            try {
                // Speech costs credits at the server, so it is only requested while the chat is set to read aloud.
                val response = api.sendMessage(message.text, voice = false, audio = wantAudio)
                _messages.update { it + ChatMessage(nextId++, false, response.reply, System.currentTimeMillis()) }
                onAnswer?.invoke(response.reply, response.audio)
            } catch (e: kotlinx.coroutines.CancellationException) {
                markFailed(message.id)
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "send failed", e)
                markFailed(message.id)
                _messages.update { it + ChatMessage(nextId++, false, "לא הצלחתי להשיג את העוזר: ${e.message ?: "שגיאה לא ידועה"}", System.currentTimeMillis(), failed = true) }
            } finally {
                _sending.value = false
                save()
            }
        }
    }

    private fun markFailed(id: Long) {
        _messages.update { list -> list.map { if (it.id == id) it.copy(failed = true) else it } }
    }

    /** Stops waiting for the answer. The question stays, marked as unsent, so it can be retried. */
    fun cancel() {
        job?.cancel()
    }

    /** A question and answer that happened by voice. */
    fun addExchange(heard: String, reply: String) {
        val now = System.currentTimeMillis()
        _messages.update { it + ChatMessage(nextId++, true, heard, now) + ChatMessage(nextId++, false, reply, now) }
        save()
    }

    fun clear() {
        job?.cancel()
        _messages.value = emptyList()
        _sending.value = false
        save()
    }

    // ── storage ──────────────────────────────────────────────────────────────

    private fun load(): List<ChatMessage> = try {
        val array = JSONArray(file.readText())
        (0 until array.length()).map {
            val o = array.getJSONObject(it)
            ChatMessage(o.getLong("id"), o.getBoolean("user"), o.getString("text"), o.getLong("time"), o.optBoolean("failed", false))
        }
    } catch (_: Exception) {
        emptyList()
    }

    private fun save() {
        val snapshot = _messages.value.takeLast(MAX_MESSAGES).filterNot { it.failed && !it.fromUser }
        scope.launch {
            withContext(Dispatchers.IO) {
                try {
                    val array = JSONArray()
                    snapshot.forEach {
                        array.put(JSONObject().put("id", it.id).put("user", it.fromUser).put("text", it.text).put("time", it.time).put("failed", it.failed))
                    }
                    val tmp = File(file.path + ".tmp")
                    tmp.writeText(array.toString())
                    tmp.renameTo(file)
                } catch (e: Exception) {
                    Log.w(TAG, "could not save the chat", e)
                }
            }
        }
    }

    companion object {
        private const val TAG = "HelperChat"
        private const val MAX_MESSAGES = 300

        @Volatile
        private var instance: ChatController? = null

        fun get(context: Context): ChatController =
            instance ?: synchronized(this) { instance ?: ChatController(context).also { instance = it } }
    }
}
