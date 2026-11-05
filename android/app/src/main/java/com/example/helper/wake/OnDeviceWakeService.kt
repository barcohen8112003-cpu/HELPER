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
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.example.helper.data.SettingsRepository
import com.example.helper.voice.LiveVoiceActivity
import com.example.helper.voice.VoiceActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Listens for "היי הלפר" or "Hey Helper" on the phone only. Off until the owner turns it on.
 * Porcupine when an AccessKey and a keyword are saved; otherwise Android's offline recognizer,
 * which is stopped if it tries to use the network. A notification stays up the whole time.
 */
class OnDeviceWakeService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private var running = false
    private var porcupine: ai.picovoice.porcupine.PorcupineManager? = null
    private var recognizer: SpeechRecognizer? = null
    private var usingMic = false
    private var holdUntil = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        startInForeground()
        if (!running) {
            running = true
            tick()
        }
        return START_STICKY
    }

    private fun startInForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "האזנה להיי הלפר", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 4, Intent(this, LiveVoiceActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 5, Intent(this, OnDeviceWakeService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("HELPER מקשיב במכשיר")
            .setContentText("אמור \"היי הלפר\" או \"Hey Helper\"")
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

    private fun tick() {
        handler.postDelayed({
            if (!running) return@postDelayed
            if (VoiceActivity.isBusy || System.currentTimeMillis() < holdUntil) {
                if (VoiceActivity.isBusy) releaseMic()
                tick()
                return@postDelayed
            }
            if (!usingMic) arm()
            tick()
        }, 1000)
    }

    private fun arm() {
        val settings = SettingsRepository.getInstance(this)
        val choice = chooseWake(
            settings.porcupineKey(),
            WakeFiles.keyword(this) != null,
            WakeFiles.model(this) != null,
            settings.jarvisWake()
        )
        if (choice.engine == WakeEngine.PORCUPINE) armPorcupine(settings.porcupineKey(), choice)
        else armOffline()
    }

    private fun armPorcupine(key: String, choice: WakeChoice) {
        try {
            recognizer?.destroy()
            recognizer = null
            val builder = ai.picovoice.porcupine.PorcupineManager.Builder().setAccessKey(key)
            val keyword = WakeFiles.keyword(this)
            if (choice.customKeyword && keyword != null) {
                builder.setKeywordPaths(arrayOf(keyword.absolutePath))
                WakeFiles.model(this)?.absolutePath?.let { builder.setModelPath(it) }
            } else {
                builder.setKeywords(arrayOf(ai.picovoice.porcupine.Porcupine.BuiltInKeyword.JARVIS))
            }
            builder.setErrorCallback { error ->
                _status.value = error?.message ?: "שגיאת מילת השכמה"
                Log.w(TAG, "porcupine ${error?.message}")
            }
            porcupine?.delete()
            porcupine = builder.build(applicationContext) { _ -> openLive() }
            porcupine?.start()
            usingMic = true
            _status.value = if (choice.jarvis && !choice.customKeyword) "מאזין: Jarvis" else "מאזין: היי הלפר"
        } catch (e: Exception) {
            _status.value = e.message ?: "Porcupine לא עלה"
            Log.w(TAG, "porcupine start", e)
            usingMic = false
            holdUntil = System.currentTimeMillis() + 15_000
        }
    }

    private fun armOffline() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            _status.value = "אין זיהוי דיבור מקומי בטלפון"
            return
        }
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(this).also { it.setRecognitionListener(offlineListener) }
        recognizer?.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "he-IL")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
        })
        usingMic = true
        _status.value = "מאזין במכשיר (בלי Picovoice)"
    }

    private val offlineListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
        override fun onPartialResults(partialResults: Bundle?) = hear(partialResults)
        override fun onResults(results: Bundle?) {
            hear(results)
            usingMic = false
        }
        override fun onError(error: Int) {
            val online = error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT
            if (online) {
                _status.value = "הזיהוי ביקש רשת, אז עצרתי. הוסף מפתח Porcupine כדי להישאר במכשיר."
                running = false
                stopSelf()
                return
            }
            usingMic = false
        }
        private fun hear(bundle: Bundle?) {
            val lines = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
            if (lines.any { WakePhrase.matches(it) }) {
                recognizer?.cancel()
                usingMic = false
                openLive()
            }
        }
    }

    private fun openLive() {
        _status.value = "שמעתי. פותח שיחה."
        releaseMic()
        val panel = Intent(this, LiveVoiceActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        try {
            startActivity(panel)
        } catch (e: Exception) {
            Log.w(TAG, "could not open the call: ${e.message}")
        }
    }

    private fun releaseMic() {
        try {
            porcupine?.stop()
        } catch (_: Exception) {
        }
        recognizer?.cancel()
        usingMic = false
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        try {
            porcupine?.delete()
        } catch (_: Exception) {
        }
        porcupine = null
        recognizer?.destroy()
        recognizer = null
        super.onDestroy()
    }

    companion object {
        private const val TAG = "HelperDeviceWake"
        private const val CHANNEL = "device_wake"
        private const val NOTIFICATION_ID = 9
        private const val ACTION_STOP = "com.example.helper.STOP_DEVICE_WAKE"
        private val _status = MutableStateFlow("")
        val status: StateFlow<String> = _status.asStateFlow()

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, OnDeviceWakeService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, OnDeviceWakeService::class.java))
        }
    }
}
