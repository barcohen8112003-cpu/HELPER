package com.example.helper.wake

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.example.helper.MainActivity
import com.example.helper.assistant.AssistantActivity
import com.example.helper.assistant.AssistantState
import com.example.helper.assistant.HelperVoiceInteractionService
import com.example.helper.voice.VoiceActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Listens for "היי בוט" and opens the assistant. Experimental: it keeps the phone's speech recognizer running in a
 * loop, which uses battery, shows the microphone indicator all the time, and may make a system click on some phones.
 * It recognises the phrase in a normal sentence-length utterance, not like a dedicated wake-word chip.
 */
class WakeWordService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var running = false
    private var fired = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground()
        if (!running) {
            running = true
            listen()
        }
        return START_STICKY
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "האזנה ל\"היי בוט\"", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, WakeWordService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("HELPER מקשיב")
            .setContentText("אמור \"היי בוט\"")
            .setContentIntent(open)
            .addAction(0, "כבה", stop)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun listen(delayMs: Long = 0) {
        handler.postDelayed({
            if (!running) return@postDelayed
            // The assistant panel is using the microphone; try again shortly.
            if (AssistantState.visible || VoiceActivity.isBusy) {
                listen(1500)
                return@postDelayed
            }
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                Log.w(TAG, "no speech recognition available")
                stopSelf()
                return@postDelayed
            }
            recognizer?.destroy()
            fired = false
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).also { it.setRecognitionListener(listener) }
            recognizer?.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "he-IL")
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            })
        }, delayMs)
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) = check(partialResults)

        override fun onResults(results: Bundle?) {
            check(results)
            if (!fired) listen(300)
        }

        override fun onError(error: Int) {
            // Silence and no-match are the normal case: nobody said anything. Just listen again.
            val quiet = error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            if (!quiet) {
                Log.w(TAG, "recognizer error $error")
                _status.value = "שגיאת זיהוי ($error)"
            }
            val wait = when {
                error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> 2000L
                quiet -> 400L
                else -> 3000L // a real failure: do not hammer the recognizer
            }
            listen(wait)
        }

        private fun check(bundle: Bundle?) {
            if (fired) return
            val heard = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
            heard.firstOrNull()?.let {
                Log.d(TAG, "heard: $it")
                _status.value = "שמעתי: $it"
            }
            if (heard.any { WakePhrase.matches(it) }) {
                fired = true
                recognizer?.cancel()
                open()
                listen(4000)
            }
        }
    }

    /**
     * Opens the overlay on top of whatever is on screen, even while HELPER itself is closed. Android only lets a
     * background app start an activity when it may draw over other apps, or when it is the default assistant;
     * without either, the best it can do is a notification that opens the overlay when tapped.
     */
    private fun open() {
        val panel = Intent(this, AssistantActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (Settings.canDrawOverlays(this)) {
            try {
                startActivity(panel)
                return
            } catch (e: Exception) {
                Log.w(TAG, "could not open the overlay: ${e.message}")
            }
        }
        if (HelperVoiceInteractionService.show()) return
        notifyHeard(panel)
    }

    private fun notifyHeard(panel: Intent) {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(HEARD_CHANNEL, "היי בוט נשמע", NotificationManager.IMPORTANCE_HIGH))
        }
        val tap = PendingIntent.getActivity(this, 2, panel, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = NotificationCompat.Builder(this, HEARD_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("שמעתי \"היי בוט\"")
            .setContentText("לחץ כדי לדבר. כדי שייפתח לבד, אפשר ל-HELPER להופיע מעל אפליקציות אחרות")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(tap)
            .setFullScreenIntent(tap, true)
            .setAutoCancel(true)
            .setTimeoutAfter(15_000)
            .build()
        manager.notify(HEARD_NOTIFICATION_ID, notification)
    }

    /** Swiping HELPER away from recent apps must not stop the listener. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (running) start(this)
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        recognizer?.destroy()
        recognizer = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "HelperWake"
        private val _status = MutableStateFlow("")
        /** The last thing the wake listener heard or the last error, for the settings card. */
        val status: StateFlow<String> = _status.asStateFlow()
        private const val CHANNEL = "wake_word"
        private const val NOTIFICATION_ID = 7
        private const val HEARD_CHANNEL = "wake_heard"
        private const val HEARD_NOTIFICATION_ID = 8
        private const val ACTION_STOP = "com.example.helper.STOP_WAKE"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, WakeWordService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, WakeWordService::class.java))
        }
    }
}

/**
 * What counts as saying the wake phrase, "היי בוט". Google's Hebrew recognizer writes it many ways: "היי בוט",
 * "הי בוט", "אי בוט", "היי, בוט", "hey bot", or glued into one word. "בוט" is short and also an ordinary word
 * ("הבוט לא עובד"), so it only counts after a greeting, or when it is almost all that was said.
 */
object WakePhrase {
    private val names = setOf("בוט", "הבוט", "בוטי", "בוד", "בוטט", "bot", "bott", "boat", "bote", "bought")
    private val greetings = setOf("היי", "הי", "הייי", "אי", "איי", "האי", "hey", "hi", "hay", "hei", "a", "ok", "okay", "אוקי", "אוקיי")

    private fun words(text: String) =
        text.lowercase().split(Regex("""[^\p{L}]+""")).filter { it.isNotEmpty() }

    fun matches(text: String): Boolean {
        val ws = words(text)
        if (ws.isEmpty()) return false
        // Said quickly it is heard as one word: "הייבוט", "היבוט", "heybot".
        if (ws.any { w -> greetings.any { g -> g.length > 1 && w.startsWith(g) && w.removePrefix(g) in names } }) return true
        return ws.indices.any { i ->
            ws[i] in names && ((i > 0 && ws[i - 1] in greetings) || (ws.size <= 2 && i == 0))
        }
    }
}
