package com.example.helper.voice

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.util.Log
import com.example.helper.network.HelperApiService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.File
import java.util.Locale

enum class Phase { Idle, Listening, Thinking, Speaking, Error }

data class VoiceState(
    val phase: Phase = Phase.Idle,
    /** What is being heard right now, while the user is still talking. */
    val partial: String = "",
    /** The last thing the user said, in full. */
    val heard: String = "",
    val reply: String = "",
    /** Microphone loudness, 0..1, smoothed. */
    val level: Float = 0f,
    /** True when the reply is spoken in the assistant's own (ElevenLabs) voice rather than the phone's. */
    val ownVoice: Boolean = false,
    /** A short explanation when something failed, including why playback fell back to the phone's voice. */
    val note: String? = null,
    /** True while a hands-free conversation is going: after each answer it listens again by itself. */
    val conversation: Boolean = false
)

/** Lets the wake phrase listener know the microphone is in use by a conversation. */
object VoiceActivity {
    private val owners = java.util.concurrent.ConcurrentHashMap.newKeySet<Any>()
    val isBusy: Boolean get() = owners.isNotEmpty()
    fun set(owner: Any, busy: Boolean) {
        if (busy) owners.add(owner) else owners.remove(owner)
    }
}

/** Saying one of these ends the conversation without asking Helper anything. */
private val GOODBYES = setOf(
    "תודה", "תודה רבה", "סיימנו", "ביי", "להתראות", "די", "מספיק", "עצור", "תפסיק", "זה הכל", "זהו",
    "תודה בוט", "ביי בוט", "תודה הלפר", "ביי הלפר", "סיימתי"
)
private const val MAX_SILENT_TURNS = 3

/**
 * Listening, asking Helper and speaking the answer. Used by the main screen and by the assistant panel,
 * so both behave the same way. Everything here runs on the main thread, as the speech APIs require.
 *
 * [startConversation] makes it hands-free: it listens, answers, and listens again until you go quiet or say goodbye.
 */
class VoiceEngine(context: Context, private val api: HelperApiService) {

    private val app = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val _state = MutableStateFlow(VoiceState())
    val state: StateFlow<VoiceState> = _state.asStateFlow()

    /** Called once the answer has finished playing. */
    var onSpoken: (() -> Unit)? = null

    /** Called with (what was said, the answer) after every successful exchange, so it can be kept in the chat history. */
    var onExchange: ((String, String) -> Unit)? = null

    /** Called when a hands-free conversation ends by itself (silence or a goodbye). */
    var onConversationEnded: (() -> Unit)? = null

    private var recognizer: SpeechRecognizer? = null
    private var player: MediaPlayer? = null
    private var tempFile: File? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var job: Job? = null
    private var relisten: Job? = null
    private var smoothedLevel = 0f
    private var silentTurns = 0

    init {
        scope.launch {
            state.collect { VoiceActivity.set(this@VoiceEngine, it.conversation || it.phase != Phase.Idle) }
        }
        tts = TextToSpeech(app) { status ->
            if (status == TextToSpeech.SUCCESS) {
                ttsReady = true
                tts?.language = Locale("he", "IL")
            }
        }
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) = finishedSpeaking()

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = finishedSpeaking()
        })
    }

    // ── conversation ─────────────────────────────────────────────────────────

    /** Starts a hands-free conversation: listen, answer, listen again, until silence or a goodbye. */
    fun startConversation() {
        silentTurns = 0
        _state.update { it.copy(conversation = true) }
        startListening()
    }

    /** Ends the conversation. [note] is shown on screen. */
    fun endConversation(note: String? = null) {
        relisten?.cancel()
        job?.cancel()
        recognizer?.cancel()
        stopSpeech()
        silentTurns = 0
        _state.update {
            it.copy(conversation = false, phase = Phase.Idle, partial = "", level = 0f, note = note ?: it.note)
        }
        onConversationEnded?.invoke()
    }

    private fun listenAgainSoon(afterMs: Long) {
        relisten?.cancel()
        relisten = scope.launch {
            delay(afterMs)
            val s = _state.value
            if (s.conversation && s.phase == Phase.Idle) startListening()
        }
    }

    /** Nobody spoke. In a conversation that is allowed a few times in a row; then it ends. */
    private fun heardNothing() {
        if (_state.value.conversation) {
            silentTurns++
            if (silentTurns >= MAX_SILENT_TURNS) {
                endConversation("לא שמעתי כלום, אז סיימתי. לחץ על הכדור כדי להמשיך")
                return
            }
            _state.update { it.copy(phase = Phase.Idle, level = 0f, partial = "") }
            listenAgainSoon(250)
        } else {
            _state.update { it.copy(phase = Phase.Idle, level = 0f, note = "לא שמעתי כלום, נסה שוב") }
        }
    }

    // ── listening ────────────────────────────────────────────────────────────

    fun startListening() {
        relisten?.cancel()
        stopSpeech()
        job?.cancel()
        if (!SpeechRecognizer.isRecognitionAvailable(app)) {
            _state.update { it.copy(phase = Phase.Error, note = "אין זיהוי דיבור זמין בטלפון הזה", conversation = false) }
            return
        }
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(app).also { it.setRecognitionListener(listener) }
        smoothedLevel = 0f
        _state.update { it.copy(phase = Phase.Listening, partial = "", level = 0f, note = null) }
        recognizer?.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "he-IL")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, app.packageName)
            // Hints for when the sentence is over, so the answer starts sooner. Some recognizers ignore them.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1100L)
        })
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onRmsChanged(rmsdB: Float) {
            // Roughly -2 dB (silence) to 10 dB (loud), smoothed so the orb does not twitch.
            val target = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
            smoothedLevel += (target - smoothedLevel) * 0.35f
            if (_state.value.phase == Phase.Listening) _state.update { it.copy(level = smoothedLevel) }
        }

        override fun onEndOfSpeech() {}

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
            if (text.isNotBlank()) _state.update { it.copy(partial = text) }
        }

        override fun onResults(results: Bundle?) {
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
            if (text.isEmpty()) {
                heardNothing()
                return
            }
            silentTurns = 0
            val clean = text.trim(' ', '.', ',', '!', '?')
            if (_state.value.conversation && clean in GOODBYES) {
                _state.update { it.copy(heard = text) }
                endConversation("סיימנו. אני כאן כשתצטרך")
                return
            }
            ask(text)
        }

        override fun onError(error: Int) {
            Log.w(TAG, "recognizer error $error")
            val soft = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            if (soft) {
                heardNothing()
                return
            }
            val note = when (error) {
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "אין רשת לזיהוי הדיבור"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "חסרה הרשאת מיקרופון"
                else -> "שגיאה בזיהוי הדיבור ($error)"
            }
            // A real failure ends the conversation: looping on it would only repeat the failure.
            _state.update { it.copy(phase = Phase.Error, level = 0f, note = note, conversation = false) }
        }
    }

    fun stopListening() {
        recognizer?.stopListening()
    }

    // ── asking ───────────────────────────────────────────────────────────────

    /** Sends text typed or spoken to Helper and speaks what comes back. */
    fun ask(text: String) {
        relisten?.cancel()
        stopSpeech()
        _state.update { it.copy(phase = Phase.Thinking, heard = text, partial = "", level = 0f, reply = "", note = null) }
        job?.cancel()
        job = scope.launch {
            try {
                val response = api.sendMessage(text, voice = true)
                _state.update { it.copy(reply = response.reply) }
                onExchange?.invoke(text, response.reply)
                speak(response.reply, response.audio)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "ask failed", e)
                _state.update {
                    it.copy(phase = Phase.Error, reply = "", note = e.message ?: "שגיאה לא ידועה", conversation = false)
                }
            }
        }
    }

    // ── speaking ─────────────────────────────────────────────────────────────

    /** Speaks a reply that came from somewhere else, such as the chat. Uses the assistant's voice when [audioBase64] is given. */
    fun play(text: String, audioBase64: String?) {
        _state.update { it.copy(reply = text, note = null) }
        speak(text, audioBase64)
    }

    fun replay() {
        val s = _state.value
        if (s.reply.isNotBlank()) speak(s.reply, null)
    }

    private fun speak(text: String, audioBase64: String?) {
        stopSpeech()
        _state.update { it.copy(phase = Phase.Speaking) }
        if (!audioBase64.isNullOrEmpty()) {
            try {
                playOwnVoice(audioBase64)
                return
            } catch (e: Exception) {
                // The reason is kept, so a silent fall back to the phone's voice never hides a real problem.
                Log.e(TAG, "playing the assistant voice failed", e)
                _state.update { it.copy(note = "קול העוזר לא התנגן (${e.javaClass.simpleName}: ${e.message}). משתמש בקול של הטלפון") }
            }
        } else if (_state.value.note == null) {
            _state.update { it.copy(note = "העוזר לא שלח קול, אז זה הקול של הטלפון") }
        }
        speakWithPhone(text)
    }

    private fun playOwnVoice(audioBase64: String) {
        val file = File.createTempFile("reply", ".mp3", app.cacheDir)
        file.writeBytes(Base64.decode(audioBase64, Base64.DEFAULT))
        tempFile = file
        val p = MediaPlayer()
        p.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        )
        p.setDataSource(file.absolutePath)
        p.setOnCompletionListener { finishedSpeaking() }
        p.setOnErrorListener { _, what, extra ->
            Log.e(TAG, "MediaPlayer error $what/$extra")
            _state.update { it.copy(note = "הניגון נכשל ($what/$extra). משתמש בקול של הטלפון") }
            val text = _state.value.reply
            releasePlayer()
            speakWithPhone(text)
            true
        }
        p.prepare()
        player = p
        _state.update { it.copy(ownVoice = true) }
        p.start()
    }

    private fun speakWithPhone(text: String) {
        _state.update { it.copy(phase = Phase.Speaking, ownVoice = false) }
        if (!ttsReady) {
            finishedSpeaking()
            return
        }
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "reply")
    }

    fun stopSpeech() {
        releasePlayer()
        tts?.stop()
        if (_state.value.phase == Phase.Speaking) _state.update { it.copy(phase = Phase.Idle, ownVoice = false) }
    }

    private fun releasePlayer() {
        try {
            player?.let { if (it.isPlaying) it.stop() }
        } catch (_: Exception) {
        }
        player?.release()
        player = null
        tempFile?.delete()
        tempFile = null
    }

    private fun finishedSpeaking() {
        scope.launch {
            releasePlayer()
            _state.update { it.copy(phase = Phase.Idle, ownVoice = false, level = 0f) }
            onSpoken?.invoke()
            // A short pause so the room's echo of the answer has died before the microphone opens again.
            if (_state.value.conversation) listenAgainSoon(450)
        }
    }

    /** Stops everything and clears the screen. */
    fun reset() {
        relisten?.cancel()
        silentTurns = 0
        job?.cancel()
        recognizer?.cancel()
        stopSpeech()
        _state.value = VoiceState()
    }

    fun release() {
        VoiceActivity.set(this, false)
        relisten?.cancel()
        job?.cancel()
        recognizer?.destroy()
        recognizer = null
        releasePlayer()
        tts?.stop()
        tts?.shutdown()
        tts = null
        scope.cancel()
    }

    companion object {
        private const val TAG = "HelperVoice"
    }
}
