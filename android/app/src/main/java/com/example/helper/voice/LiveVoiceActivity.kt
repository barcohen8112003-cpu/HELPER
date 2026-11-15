package com.example.helper.voice

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.example.helper.data.SettingsRepository
import com.example.helper.network.HelperApiService
import com.example.helper.ui.theme.HelperTheme
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import kotlinx.coroutines.launch

/**
 * One live, interruptible call. The phone only carries the microphone and the speaker.
 * HELPER, on the server, hears, thinks with its tools, and talks.
 */
class LiveVoiceActivity : ComponentActivity() {
    private var room: Room? = null
    private var status by mutableStateOf("מתחבר…")
    private var error by mutableStateOf<String?>(null)
    private var inCall by mutableStateOf(false)
    private var muted by mutableStateOf(false)

    private val micLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCall() else error = "בלי מיקרופון אי אפשר לדבר"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            HelperTheme {
                Column(
                    Modifier.fillMaxSize().background(Color(0xFF070B14)).padding(28.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Text("HELPER", color = Color(0xFFD7F7FF), fontSize = 36.sp, letterSpacing = 6.sp)
                    Spacer(Modifier.height(16.dp))
                    Text(status, color = Color(0xFFE8F1FF), fontSize = 20.sp, textAlign = TextAlign.Center)
                    error?.let {
                        Spacer(Modifier.height(12.dp))
                        Text(it, color = Color(0xFFFFB4B4), fontSize = 16.sp, textAlign = TextAlign.Center)
                    }
                    Spacer(Modifier.height(28.dp))
                    if (inCall) {
                        Button(onClick = {
                            muted = !muted
                            lifecycleScope.launch { room?.localParticipant?.setMicrophoneEnabled(!muted) }
                        }) { Text(if (muted) "בטל השתקה" else "השתק") }
                        Spacer(Modifier.height(12.dp))
                        Button(
                            onClick = { finish() },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF3A2030))
                        ) { Text("נתק") }
                    }
                }
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            startCall()
        } else {
            micLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startCall() {
        val api = HelperApiService(SettingsRepository.getInstance(this))
        lifecycleScope.launch {
            val join = try {
                api.joinLive()
            } catch (e: Exception) {
                error = e.message ?: "אין חיבור"
                status = "לא נכנסתי לשיחה"
                return@launch
            }
            if (!join.ok || join.url.isNullOrBlank() || join.token.isNullOrBlank()) {
                error = join.reason ?: "השיחה החיה כבויה בשרת"
                status = "השיחה החיה כבויה"
                return@launch
            }
            LiveVoiceService.start(this@LiveVoiceActivity)
            VoiceActivity.set(this@LiveVoiceActivity, true)
            val next = LiveKit.create(applicationContext)
            room = next
            launch {
                next.events.collect { event ->
                    if (event is RoomEvent.Disconnected) status = "השיחה נותקה"
                }
            }
            try {
                next.connect(join.url, join.token)
                next.localParticipant.setMicrophoneEnabled(true)
                inCall = true
                status = "אני איתך. דבר, ואפשר לקטוע אותי באמצע."
            } catch (e: Exception) {
                error = e.message ?: "החיבור נכשל"
                status = "לא נכנסתי לשיחה"
                inCall = false
            }
        }
    }

    override fun onDestroy() {
        VoiceActivity.set(this, false)
        val current = room
        room = null
        try {
            current?.disconnect()
            current?.release()
        } catch (_: Exception) {
        }
        LiveVoiceService.stop(this)
        super.onDestroy()
    }
}
