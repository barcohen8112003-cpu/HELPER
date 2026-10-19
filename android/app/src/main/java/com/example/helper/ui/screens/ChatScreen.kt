package com.example.helper.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Base64
import android.widget.Toast
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.helper.chat.ChatController
import com.example.helper.chat.ChatMessage
import com.example.helper.chat.firstLink
import com.example.helper.chat.renderChatText
import com.example.helper.data.SettingsRepository
import com.example.helper.network.HelperApiService
import com.example.helper.ui.components.AuroraBackground
import com.example.helper.ui.components.GradientText
import com.example.helper.ui.components.HelperOrb
import com.example.helper.ui.theme.Blue
import com.example.helper.ui.theme.Cyan
import com.example.helper.ui.theme.Mint
import com.example.helper.ui.theme.Pink
import com.example.helper.ui.theme.TextHigh
import com.example.helper.ui.theme.TextLow
import com.example.helper.ui.theme.TextMid
import com.example.helper.ui.theme.Violet
import com.example.helper.voice.Phase
import com.example.helper.voice.VoiceEngine
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val SUGGESTIONS = listOf(
    "מה יש לי היום?",
    "מה חדש במייל?",
    "תזכיר לי מחר בבוקר",
    "מה מזג האוויר?",
    "תעזור לי להתכונן למבחן",
    "תסכם לי את החדשות"
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChatScreen(
    settingsRepository: SettingsRepository,
    onOpenVoice: () -> Unit,
    onOpenSettings: () -> Unit
) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val controller = remember { ChatController.get(context) }
    val api = remember { HelperApiService(settingsRepository) }
    val scope = rememberCoroutineScope()
    // Reading answers aloud is the default; the speaker button mutes it, and the choice is remembered.
    var speak by remember { mutableStateOf(settingsRepository.isChatSpeakEnabled()) }
    val voice = remember { VoiceEngine(context, api) }
    val voiceState by voice.state.collectAsState()
    val messages by controller.messages.collectAsState()
    val sending by controller.sending.collectAsState()
    var draft by remember { mutableStateOf("") }
    var confirmClear by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    // Stay at the newest message when something arrives or the answer starts to be awaited.
    LaunchedEffect(messages.size, sending) {
        val last = messages.size + (if (sending) 1 else 0) - 1
        if (last >= 0) listState.animateScrollToItem(last)
    }

    DisposableEffect(voice) {
        controller.onAnswer = { reply, audio -> if (speak) voice.play(reply, audio) }
        onDispose {
            controller.onAnswer = null
            voice.release()
        }
    }
    LaunchedEffect(speak) {
        controller.wantAudio = speak
        if (!speak) voice.stopSpeech()
    }

    fun send(text: String) {
        if (text.isBlank()) return
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        voice.stopSpeech()
        controller.send(text, api)
        draft = ""
    }

    // Reads one message again in the assistant's voice, whatever the mute setting is.
    fun readAloud(text: String) {
        scope.launch {
            try {
                val mp3 = api.speech(text)
                voice.play(text, Base64.encodeToString(mp3, Base64.NO_WRAP))
            } catch (e: Exception) {
                Toast.makeText(context, "ההקראה נכשלה: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        AuroraBackground(if (sending) Phase.Thinking else Phase.Idle, Modifier.fillMaxSize())

        Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
            TopBar(
                connected = settingsRepository.hasConnectionDetails(),
                busy = sending,
                canClear = messages.isNotEmpty(),
                speaking = voiceState.phase == Phase.Speaking,
                speakOn = speak,
                onToggleSpeak = {
                    speak = !speak
                    settingsRepository.setChatSpeakEnabled(speak)
                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                },
                onSettings = onOpenSettings,
                onVoice = onOpenVoice,
                onClear = { confirmClear = true }
            )

            if (messages.isEmpty() && !sending) {
                EmptyState(Modifier.weight(1f), onPick = { send(it) })
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    items(messages, key = { it.id }) { message ->
                        Bubble(
                            message = message,
                            onCopy = {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                clipboard.setPrimaryClip(ClipData.newPlainText("HELPER", message.text))
                                Toast.makeText(context, "הועתק", Toast.LENGTH_SHORT).show()
                            },
                            onOpenLink = { link ->
                                try {
                                    context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                                } catch (_: Exception) {
                                }
                            },
                            onRetry = { controller.retry(message.id, api) },
                            onReadAloud = { readAloud(message.text) }
                        )
                    }
                    if (sending) item(key = "typing") { TypingBubble() }
                }
            }

            InputBar(
                draft = draft,
                onDraft = { draft = it },
                sending = sending,
                onSend = { send(draft) },
                onStop = { controller.cancel() },
                onVoice = onOpenVoice
            )
        }
    }

    if (confirmClear) {
        AlertDialog(
            onDismissRequest = { confirmClear = false },
            title = { Text("להתחיל שיחה חדשה?") },
            text = { Text("ההיסטוריה שבאפליקציה תימחק. ל-HELPER יש זיכרון משלו, והוא לא יושפע.") },
            confirmButton = { TextButton(onClick = { controller.clear(); confirmClear = false }) { Text("מחק") } },
            dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("ביטול") } }
        )
    }
}

@Composable
private fun TopBar(
    connected: Boolean,
    busy: Boolean,
    canClear: Boolean,
    speaking: Boolean,
    speakOn: Boolean,
    onToggleSpeak: () -> Unit,
    onSettings: () -> Unit,
    onVoice: () -> Unit,
    onClear: () -> Unit
) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        RoundButton("⚙", onSettings)
        Spacer(Modifier.size(8.dp))
        if (canClear) RoundButton("＋", onClear)
        Spacer(Modifier.weight(1f))
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("HELPER", style = GradientText, fontSize = 22.sp, fontWeight = FontWeight.Black, letterSpacing = 3.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(if (!connected) Pink else if (busy) Cyan else Mint))
                Spacer(Modifier.size(5.dp))
                Text(if (!connected) "לא מחובר" else if (busy) "חושב..." else "מחובר", color = TextLow, fontSize = 11.sp)
            }
        }
        Spacer(Modifier.weight(1f))
        RoundButton(if (speakOn) (if (speaking) "🔊" else "🔉") else "🔇", onToggleSpeak, highlighted = speakOn && speaking)
        Spacer(Modifier.size(8.dp))
        RoundButton("🎙", onVoice)
    }
}

@Composable
private fun RoundButton(glyph: String, onClick: () -> Unit, highlighted: Boolean = false) {
    Box(
        Modifier.size(40.dp).clip(CircleShape).background(if (highlighted) Cyan.copy(alpha = 0.35f) else Color.White.copy(alpha = 0.08f)).clickable { onClick() },
        contentAlignment = Alignment.Center
    ) { Text(glyph, color = TextHigh, fontSize = 17.sp) }
}

@Composable
private fun EmptyState(modifier: Modifier, onPick: (String) -> Unit) {
    Column(modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        HelperOrb(phase = Phase.Idle, level = 0f, size = 210.dp)
        Text("במה אפשר לעזור?", color = TextHigh, fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(4.dp))
        Text("כתוב, או לחץ על המיקרופון ודבר", color = TextLow, fontSize = 14.sp)
        Spacer(Modifier.height(18.dp))
        // Two columns of suggestions; a tap sends it as written.
        SUGGESTIONS.chunked(2).forEach { pair ->
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                pair.forEach { text ->
                    Box(
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(18.dp))
                            .background(Color.White.copy(alpha = 0.07f))
                            .border(1.dp, Color.White.copy(alpha = 0.14f), RoundedCornerShape(18.dp))
                            .clickable { onPick(text) }
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        contentAlignment = Alignment.Center
                    ) { Text(text, color = TextMid, fontSize = 13.sp, textAlign = TextAlign.Center) }
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Bubble(message: ChatMessage, onCopy: () -> Unit, onOpenLink: (String) -> Unit, onRetry: () -> Unit, onReadAloud: () -> Unit) {
    val mine = message.fromUser
    val shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = if (mine) 20.dp else 6.dp, bottomEnd = if (mine) 6.dp else 20.dp)
    val text = remember(message.text) { renderChatText(message.text, Cyan, Color.White.copy(alpha = 0.14f)) }
    val link = remember(message.text) { firstLink(message.text) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            Box(
                Modifier
                    .widthIn(max = 320.dp)
                    .clip(shape)
                    .then(
                        if (mine) Modifier.background(Brush.linearGradient(listOf(Violet, Blue)))
                        else Modifier.background(Color.White.copy(alpha = 0.08f)).border(1.dp, Color.White.copy(alpha = 0.16f), shape)
                    )
                    .combinedClickable(onClick = { link?.let(onOpenLink) }, onLongClick = onCopy)
                    .padding(horizontal = 14.dp, vertical = 10.dp)
            ) {
                Text(text, color = if (message.failed && !mine) Pink else Color.White, fontSize = 16.sp, lineHeight = 23.sp)
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp)) {
                if (message.failed && mine) {
                    Text("לא נשלח · נסה שוב", color = Pink, fontSize = 11.sp, modifier = Modifier.clickable { onRetry() })
                } else {
                    Text(SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(message.time)), color = TextLow, fontSize = 10.sp)
                    if (!mine && !message.failed) {
                        Spacer(Modifier.size(10.dp))
                        Text("🔈 הקרא", color = Cyan, fontSize = 11.sp, modifier = Modifier.clickable { onReadAloud() })
                    }
                }
            }
        }
    }
}

@Composable
private fun TypingBubble() {
    val transition = rememberInfiniteTransition(label = "typing")
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
        Row(
            Modifier
                .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 6.dp, bottomEnd = 20.dp))
                .background(Color.White.copy(alpha = 0.08f))
                .padding(horizontal = 16.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(5.dp)
        ) {
            repeat(3) { i ->
                val a by transition.animateFloat(
                    initialValue = 0.25f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(tween(600, delayMillis = i * 160, easing = LinearEasing), RepeatMode.Reverse),
                    label = "dot$i"
                )
                Box(Modifier.size(8.dp).alpha(a).clip(CircleShape).background(Cyan))
            }
        }
    }
}

@Composable
private fun InputBar(draft: String, onDraft: (String) -> Unit, sending: Boolean, onSend: () -> Unit, onStop: () -> Unit, onVoice: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Box(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(26.dp))
                .background(Color.White.copy(alpha = 0.08f))
                .border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(26.dp))
                .padding(horizontal = 18.dp, vertical = 12.dp)
        ) {
            BasicTextField(
                value = draft,
                onValueChange = onDraft,
                textStyle = TextStyle(color = TextHigh, fontSize = 16.sp, lineHeight = 22.sp),
                cursorBrush = SolidColor(Cyan),
                maxLines = 6,
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { inner ->
                    if (draft.isEmpty()) Text("שאל כל דבר...", color = TextLow, fontSize = 16.sp)
                    inner()
                }
            )
        }
        val action = when {
            sending -> "■"
            draft.isNotBlank() -> "➤"
            else -> "🎙"
        }
        Box(
            Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(Brush.linearGradient(listOf(Cyan, Violet)))
                .clickable {
                    when {
                        sending -> onStop()
                        draft.isNotBlank() -> onSend()
                        else -> onVoice()
                    }
                },
            contentAlignment = Alignment.Center
        ) { Text(action, color = Color.White, fontSize = 19.sp) }
    }
}
