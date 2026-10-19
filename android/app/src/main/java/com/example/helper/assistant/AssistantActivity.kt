package com.example.helper.assistant

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.example.helper.MainActivity
import com.example.helper.chat.ChatController
import com.example.helper.data.SettingsRepository
import com.example.helper.network.HelperApiService
import com.example.helper.ui.components.HelperOrb
import com.example.helper.ui.theme.Amber
import com.example.helper.ui.theme.Blue
import com.example.helper.ui.theme.Cyan
import com.example.helper.ui.theme.HelperTheme
import com.example.helper.ui.theme.Ice
import com.example.helper.ui.theme.Lavender
import com.example.helper.ui.theme.Magenta
import com.example.helper.ui.theme.Orange
import com.example.helper.ui.theme.Pink
import com.example.helper.ui.theme.Red
import com.example.helper.ui.theme.TextHigh
import com.example.helper.ui.theme.TextLow
import com.example.helper.ui.theme.TextMid
import com.example.helper.ui.theme.Violet
import com.example.helper.voice.Phase
import com.example.helper.voice.VoiceEngine
import com.example.helper.voice.VoiceState
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * The Gemini-style overlay that rises over whatever you were doing when the assistant is called (long-press power or
 * "היי בוט"): a soft glow across the bottom of the screen and a dark pill, the app underneath stays visible. It starts
 * listening by itself and closes a few seconds after the answer has been spoken. It is deliberately not shown over the
 * lock screen: it can read your mail and calendar, so it waits until the phone is unlocked.
 */
class AssistantActivity : ComponentActivity() {

    private lateinit var engine: VoiceEngine
    private var micGranted = false

    private val askForMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        micGranted = granted
        if (granted) engine.startConversation() else finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        engine = VoiceEngine(this, HelperApiService(SettingsRepository.getInstance(this)))
        engine.onExchange = { heard, reply -> ChatController.get(this).addExchange(heard, reply) }
        micGranted = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

        setContent {
            HelperTheme {
                AssistantPanel(
                    engine = engine,
                    connected = SettingsRepository.getInstance(this).hasConnectionDetails(),
                    onOpenApp = {
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        finish()
                    },
                    onClose = { finish() }
                )
            }
        }
        begin()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        begin()
    }

    private fun begin() {
        if (micGranted) engine.startConversation() else askForMic.launch(Manifest.permission.RECORD_AUDIO)
    }

    override fun onStart() {
        super.onStart()
        AssistantState.visible = true
    }

    override fun onStop() {
        super.onStop()
        AssistantState.visible = false
        // Sent to the background (home, another app): stop talking and listening.
        engine.reset()
    }

    override fun onDestroy() {
        AssistantState.visible = false
        engine.release()
        super.onDestroy()
    }
}

/** Lets the wake phrase service know the panel is open, so it does not trigger a second one on top. */
object AssistantState {
    @Volatile
    var visible = false
}

@Composable
private fun AssistantPanel(engine: VoiceEngine, connected: Boolean, onOpenApp: () -> Unit, onClose: () -> Unit) {
    val state by engine.state.collectAsState()
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { shown = true }

    // The conversation runs by itself; once it has ended (silence, goodbye or an error) the panel closes.
    LaunchedEffect(state.phase, state.conversation, state.reply) {
        if (!state.conversation && state.phase == Phase.Idle) {
            delay(if (state.reply.isNotBlank()) 5000 else 3000)
            onClose()
        }
    }

    val level by animateFloatAsState(state.level, spring(stiffness = Spring.StiffnessMediumLow), label = "level")
    val glowIn by animateFloatAsState(if (shown) 1f else 0f, tween(700), label = "glowIn")

    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        Box(
            Modifier
                .fillMaxSize()
                // Only the lower part is shaded, so the app underneath stays readable, like Gemini's overlay.
                .background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.55f)))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { onClose() }
        ) {
            BottomGlow(
                phase = state.phase,
                level = level,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .height(340.dp)
                    .graphicsLayer { alpha = glowIn }
            )
            AnimatedVisibility(
                visible = shown,
                modifier = Modifier.align(Alignment.BottomCenter),
                enter = slideInVertically(initialOffsetY = { it / 2 }) + fadeIn(),
                exit = slideOutVertically(targetOffsetY = { it / 2 }) + fadeOut()
            ) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .navigationBarsPadding()
                        .padding(horizontal = 16.dp, vertical = 14.dp)
                        // Taps on the panel must not fall through to the shaded area, which closes it.
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    TranscriptCard(state, connected, level)
                    Spacer(Modifier.height(12.dp))
                    AskPill(
                        state = state,
                        level = level,
                        onPlus = onOpenApp,
                        onMic = { if (state.phase == Phase.Listening) engine.stopListening() else engine.startListening() },
                        onLive = { if (state.conversation) engine.endConversation() else engine.startConversation() }
                    )
                }
            }
        }
    }
}

/** What was heard and what Helper answered, in a dark glass card above the pill, with the orb beside it. */
@Composable
private fun TranscriptCard(state: VoiceState, connected: Boolean, level: Float) {
    val heard = if (state.phase == Phase.Listening && state.partial.isNotBlank()) state.partial else state.heard
    val reply = if (state.phase == Phase.Listening) "" else state.reply
    val note = if (!connected) statusText(state.phase, false) else state.note
    AnimatedVisibility(
        visible = heard.isNotBlank() || reply.isNotBlank() || note != null,
        enter = fadeIn() + expandVertically(),
        exit = fadeOut() + shrinkVertically()
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(28.dp))
                .background(Color(0xE6121218))
                .border(1.dp, Color.White.copy(alpha = 0.08f), RoundedCornerShape(28.dp))
                .animateContentSize()
                .padding(start = 8.dp, end = 20.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.Top
        ) {
            HelperOrb(phase = state.phase, level = level, size = 44.dp)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f).padding(top = 4.dp)) {
                if (heard.isNotBlank()) {
                    Text(heard, color = TextMid, fontSize = 15.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
                if (reply.isNotBlank()) {
                    if (heard.isNotBlank()) Spacer(Modifier.height(10.dp))
                    Text(
                        reply,
                        color = TextHigh,
                        fontSize = 18.sp,
                        lineHeight = 25.sp,
                        modifier = Modifier
                            .heightIn(max = 260.dp)
                            .verticalScroll(rememberScrollState())
                    )
                }
                note?.let {
                    Spacer(Modifier.height(6.dp))
                    Text(it, color = TextLow, fontSize = 12.sp)
                }
            }
        }
    }
}

/**
 * The dark pill from Gemini's overlay, in Hebrew: "+" opens the app, the text shows what is being heard,
 * the microphone asks one question and the waveform starts or ends a hands-free conversation.
 * Its edge is a rotating gradient that thickens with your voice.
 */
@Composable
private fun AskPill(state: VoiceState, level: Float, onPlus: () -> Unit, onMic: () -> Unit, onLive: () -> Unit) {
    val t = rememberInfiniteTransition(label = "pill")
    val spin by t.animateFloat(0f, 360f, infiniteRepeatable(tween(4000, easing = LinearEasing)), label = "spin")
    val active = state.phase != Phase.Idle
    val edge by animateFloatAsState(if (active) 1f else 0.35f, tween(500), label = "edge")
    val colors = glowColors(state.phase)
    val shape = RoundedCornerShape(50)
    val listening = state.phase == Phase.Listening

    Box(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .drawBehind {
                rotate(spin) {
                    drawCircle(
                        Brush.sweepGradient(listOf(colors[0], colors[1], colors[2], colors[3], colors[0])),
                        radius = size.maxDimension,
                        alpha = edge
                    )
                }
            }
            .padding((1.5f + level * 2.5f).dp)
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(Color(0xFF16161C))
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconCircle(onClick = onPlus) { PlusIcon() }
            Spacer(Modifier.width(6.dp))
            Text(
                text = when {
                    listening && state.partial.isNotBlank() -> state.partial
                    listening -> "מקשיב..."
                    state.phase == Phase.Thinking -> "חושב..."
                    state.phase == Phase.Speaking -> "מדבר..."
                    else -> "שאל את הבוט"
                },
                color = if (listening && state.partial.isNotBlank()) TextHigh else TextMid,
                fontSize = 18.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            val micBg by animateColorAsState(if (listening) Color(0xFF3B5BDB) else Color(0xFF2B3550), tween(300), label = "micBg")
            IconCircle(onClick = onMic, background = micBg, scale = 1f + if (listening) level * 0.18f else 0f) { MicIcon() }
            Spacer(Modifier.width(4.dp))
            IconCircle(onClick = onLive) { WaveIcon(level = if (active) level else 0f, live = state.conversation) }
        }
    }
}

@Composable
private fun IconCircle(onClick: () -> Unit, background: Color = Color.Transparent, scale: Float = 1f, content: @Composable () -> Unit) {
    Box(
        Modifier
            .size(48.dp)
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(CircleShape)
            .background(background)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) { content() }
}

@Composable
private fun PlusIcon() {
    Canvas(Modifier.size(22.dp)) {
        val w = 2.2.dp.toPx()
        drawLine(Color.White, Offset(size.width / 2, 0f), Offset(size.width / 2, size.height), w, StrokeCap.Round)
        drawLine(Color.White, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), w, StrokeCap.Round)
    }
}

@Composable
private fun MicIcon() {
    Canvas(Modifier.size(24.dp)) {
        val w = 2.dp.toPx()
        val cw = size.width * 0.36f
        drawRoundRect(
            Color.White,
            topLeft = Offset((size.width - cw) / 2, 0f),
            size = Size(cw, size.height * 0.6f),
            cornerRadius = CornerRadius(cw / 2)
        )
        val arc = size.width * 0.64f
        val arcTop = size.height * 0.62f - arc / 2
        drawArc(
            Color.White, 0f, 180f, false,
            topLeft = Offset((size.width - arc) / 2, arcTop),
            size = Size(arc, arc),
            style = Stroke(w, cap = StrokeCap.Round)
        )
        drawLine(Color.White, Offset(size.width / 2, arcTop + arc), Offset(size.width / 2, size.height), w, StrokeCap.Round)
    }
}

/** Gemini's "Live" waveform glyph; its bars move with the voice while something is happening. */
@Composable
private fun WaveIcon(level: Float, live: Boolean) {
    val t = rememberInfiniteTransition(label = "wave")
    val p by t.animateFloat(0f, 1f, infiniteRepeatable(tween(900, easing = LinearEasing)), label = "p")
    val tint = if (live) Ice else Color.White
    Canvas(Modifier.size(24.dp)) {
        val base = floatArrayOf(0.35f, 0.75f, 1f, 0.75f, 0.35f)
        val gap = size.width / base.size
        base.forEachIndexed { i, b ->
            val wobble = (sin((p + i * 0.2f) * 2 * PI).toFloat() + 1f) / 2f
            val h = size.height * (b * (0.55f + 0.45f * level * wobble)).coerceIn(0.2f, 1f)
            val x = gap * (i + 0.5f)
            drawLine(tint, Offset(x, (size.height - h) / 2), Offset(x, (size.height + h) / 2), 2.2.dp.toPx(), StrokeCap.Round)
        }
    }
}

private fun glowColors(phase: Phase) = when (phase) {
    Phase.Listening -> listOf(Blue, Cyan, Violet, Color(0xFF4F7CFF))
    Phase.Thinking -> listOf(Violet, Magenta, Blue, Lavender)
    Phase.Speaking -> listOf(Lavender, Pink, Blue, Ice)
    Phase.Error -> listOf(Red, Orange, Amber, Pink)
    Phase.Idle -> listOf(Blue, Violet, Cyan, Lavender)
}

/**
 * The soft blue and purple light across the bottom of the screen. Blobs of colour drift sideways, breathe slowly,
 * and swell with the microphone level while listening.
 */
@Composable
private fun BottomGlow(phase: Phase, level: Float, modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "glow")
    val p by t.animateFloat(0f, 1f, infiniteRepeatable(tween(9000, easing = LinearEasing)), label = "p")
    val target = glowColors(phase)
    val c0 by animateColorAsState(target[0], tween(700), label = "c0")
    val c1 by animateColorAsState(target[1], tween(700), label = "c1")
    val c2 by animateColorAsState(target[2], tween(700), label = "c2")
    val c3 by animateColorAsState(target[3], tween(700), label = "c3")
    val strength by animateFloatAsState(if (phase == Phase.Idle) 0.55f else 1f, tween(600), label = "strength")

    Canvas(modifier) {
        val a = (p * 2 * PI).toFloat()
        val breathe = 0.5f + 0.5f * sin(a * 3)
        val swell = 1f + level * 0.7f + breathe * 0.08f
        val blobs = listOf(
            Triple(c0, 0.2f + 0.12f * sin(a), 0.62f),
            Triple(c1, 0.5f + 0.15f * sin(a * 2 + 1f), 0.75f),
            Triple(c2, 0.8f + 0.12f * sin(a + 2.5f), 0.62f),
            Triple(c3, 0.5f + 0.3f * cos(a), 0.5f)
        )
        blobs.forEach { (color, x, r) ->
            val radius = size.width * r * swell
            val center = Offset(size.width * x, size.height * (1.08f - 0.06f * level))
            drawCircle(
                Brush.radialGradient(
                    0f to color.copy(alpha = 0.55f * strength),
                    0.45f to color.copy(alpha = 0.22f * strength),
                    1f to Color.Transparent,
                    center = center,
                    radius = radius
                ),
                radius = radius,
                center = center,
                blendMode = BlendMode.Plus
            )
        }
        // A bright thin line right at the bottom edge, like the system assistant glow.
        val line = 3.dp.toPx()
        drawRect(
            Brush.horizontalGradient(listOf(c0, c1, c2, c3, c0).map { it.copy(alpha = (0.6f + level * 0.4f) * strength) }),
            topLeft = Offset(0f, size.height - line),
            size = Size(size.width, line)
        )
    }
}

private fun statusText(phase: Phase, connected: Boolean) = when {
    !connected -> "לא מחובר למחשב. פתח את האפליקציה כדי להתחבר"
    phase == Phase.Listening -> "מקשיב..."
    phase == Phase.Thinking -> "חושב..."
    phase == Phase.Speaking -> "מדבר..."
    phase == Phase.Error -> "משהו השתבש"
    else -> "אני כאן"
}
