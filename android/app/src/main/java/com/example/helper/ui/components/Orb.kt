package com.example.helper.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.withFrameNanos
import com.example.helper.ui.theme.Amber
import com.example.helper.ui.theme.Blue
import com.example.helper.ui.theme.Cyan
import com.example.helper.ui.theme.Ice
import com.example.helper.ui.theme.Lavender
import com.example.helper.ui.theme.Magenta
import com.example.helper.ui.theme.Mint
import com.example.helper.ui.theme.Nebula
import com.example.helper.ui.theme.Orange
import com.example.helper.ui.theme.Pink
import com.example.helper.ui.theme.Red
import com.example.helper.ui.theme.Violet
import com.example.helper.ui.theme.Void
import com.example.helper.voice.Phase
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

private data class Palette(val a: Color, val b: Color, val c: Color)

private fun paletteFor(phase: Phase) = when (phase) {
    Phase.Idle -> Palette(Violet, Cyan, Pink)
    Phase.Listening -> Palette(Cyan, Blue, Mint)
    Phase.Thinking -> Palette(Orange, Magenta, Violet)
    Phase.Speaking -> Palette(Pink, Lavender, Ice)
    Phase.Error -> Palette(Red, Orange, Amber)
}

/** Seconds of animation per real second: the orb spins up while it thinks and settles when idle. */
private fun speedFor(phase: Phase) = when (phase) {
    Phase.Idle -> 0.45f
    Phase.Listening -> 1.0f
    Phase.Thinking -> 3.2f
    Phase.Speaking -> 1.5f
    Phase.Error -> 0.8f
}

/**
 * The assistant itself: a living blob of light. Its colour says what it is doing, its edge ripples with your voice
 * while it listens, spins while it thinks and pulses while it talks. [level] is the microphone loudness, 0..1.
 */
@Composable
fun HelperOrb(
    phase: Phase,
    level: Float,
    size: Dp,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null
) {
    val a by animateColorAsState(paletteFor(phase).a, tween(700), label = "a")
    val b by animateColorAsState(paletteFor(phase).b, tween(700), label = "b")
    val c by animateColorAsState(paletteFor(phase).c, tween(700), label = "c")
    val smooth by animateFloatAsState(level, spring(stiffness = Spring.StiffnessMedium), label = "level")
    val speaking by animateFloatAsState(if (phase == Phase.Speaking) 1f else 0f, tween(500), label = "speaking")
    val thinking by animateFloatAsState(if (phase == Phase.Thinking) 1f else 0f, tween(500), label = "thinking")
    val listening by animateFloatAsState(if (phase == Phase.Listening) 1f else 0f, tween(400), label = "listening")

    // One clock drives every motion. It advances faster or slower with the phase, so speed changes never jump.
    val speed by rememberUpdatedState(speedFor(phase))
    var clock by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(Unit) {
        var last = 0L
        while (true) {
            withFrameNanos { now ->
                if (last != 0L) clock += (now - last) / 1_000_000_000f * speed
                last = now
            }
        }
    }

    val density = LocalDensity.current
    val interaction = remember { MutableInteractionSource() }
    val click = if (onClick != null) Modifier.clickable(interactionSource = interaction, indication = null) { onClick() } else Modifier

    Box(modifier = modifier.size(size).then(click)) {
        Canvas(Modifier.fillMaxSize()) {
            val t = clock
            val center = Offset(this.size.width / 2f, this.size.height / 2f)
            val base = this.size.minDimension / 2f * 0.5f
            val breath = 1f + 0.03f * sin(t * 1.3f) + 0.16f * smooth * listening + 0.05f * sin(t * 6f) * speaking

            // Soft halo that fills the whole canvas.
            drawCircle(
                brush = Brush.radialGradient(
                    0f to a.copy(alpha = 0.50f),
                    0.45f to b.copy(alpha = 0.20f),
                    1f to Color.Transparent,
                    center = center,
                    radius = this.size.minDimension / 2f
                ),
                radius = this.size.minDimension / 2f,
                center = center
            )

            // Orbiting rings that sweep colour around themselves.
            for (i in 0 until 3) {
                val ringRadius = base * (1.32f + 0.16f * i) * (1f + 0.02f * sin(t * 1.1f + i))
                val spin = (t * (22f + 14f * i) * (if (i % 2 == 0) 1f else -1f)) % 360f
                rotate(spin, center) {
                    drawCircle(
                        brush = Brush.sweepGradient(
                            listOf(Color.Transparent, a.copy(alpha = 0.75f - 0.18f * i), Color.Transparent, c.copy(alpha = 0.55f - 0.14f * i), Color.Transparent),
                            center = center
                        ),
                        radius = ringRadius,
                        center = center,
                        style = Stroke(width = (2.6f - 0.6f * i) * density.density)
                    )
                }
            }

            drawParticles(center, base, t, a, b, c, density.density, 0.6f + 0.4f * thinking)

            // The body: a circle whose edge is pushed in and out by three travelling waves.
            val ripple = 0.035f + 0.10f * smooth * listening + 0.05f * speaking + 0.05f * thinking
            val body = Path()
            val points = 120
            for (i in 0..points) {
                val angle = i / points.toFloat() * 2f * PI.toFloat()
                val wobble = 1f +
                    ripple * sin(3 * angle + t * 1.7f) +
                    ripple * 0.7f * sin(5 * angle - t * 2.3f) +
                    ripple * 0.5f * sin(7 * angle + t * 3.1f)
                val r = base * breath * wobble
                val x = center.x + r * cos(angle)
                val y = center.y + r * sin(angle)
                if (i == 0) body.moveTo(x, y) else body.lineTo(x, y)
            }
            body.close()

            val lightSource = Offset(center.x - base * 0.35f, center.y - base * 0.4f)
            drawPath(
                path = body,
                brush = Brush.radialGradient(
                    0f to Color.White.copy(alpha = 0.95f),
                    0.18f to b,
                    0.62f to a,
                    1f to c.copy(alpha = 0.9f),
                    center = lightSource,
                    radius = base * 1.9f
                )
            )
            // Glassy edge.
            rotate((t * 40f) % 360f, center) {
                drawPath(
                    path = body,
                    brush = Brush.sweepGradient(listOf(Color.White.copy(alpha = 0.9f), Color.Transparent, c.copy(alpha = 0.8f), Color.Transparent, Color.White.copy(alpha = 0.9f)), center = center),
                    style = Stroke(width = 2f * density.density)
                )
            }
            // A small bright highlight, like light on a sphere.
            drawCircle(
                brush = Brush.radialGradient(listOf(Color.White.copy(alpha = 0.55f), Color.Transparent), center = lightSource, radius = base * 0.45f),
                radius = base * 0.45f,
                center = lightSource
            )
        }
    }
}

private fun DrawScope.drawParticles(center: Offset, base: Float, t: Float, a: Color, b: Color, c: Color, density: Float, energy: Float) {
    val count = 42
    for (i in 0 until count) {
        val seed = i * 0.61803f
        val angle = (i / count.toFloat()) * 2f * PI.toFloat() + t * (0.12f + (i % 5) * 0.035f) * (if (i % 2 == 0) 1f else -1f)
        val distance = base * (1.5f + 0.75f * (seed % 1f)) + base * 0.05f * sin(t * 1.4f + i)
        val twinkle = 0.25f + 0.75f * (0.5f + 0.5f * sin(t * (1.2f + (i % 4) * 0.4f) + i))
        val color = when (i % 3) { 0 -> a; 1 -> b; else -> c }
        drawCircle(
            color = color.copy(alpha = (twinkle * energy).coerceIn(0f, 1f)),
            radius = (1.2f + (i % 4) * 0.7f) * density,
            center = Offset(center.x + distance * cos(angle), center.y + distance * sin(angle))
        )
    }
}

/** The backdrop: deep space with three slow coloured clouds that follow the orb's mood. */
@Composable
fun AuroraBackground(phase: Phase, modifier: Modifier = Modifier) {
    val a by animateColorAsState(paletteFor(phase).a, tween(1200), label = "bgA")
    val b by animateColorAsState(paletteFor(phase).b, tween(1200), label = "bgB")
    val c by animateColorAsState(paletteFor(phase).c, tween(1200), label = "bgC")
    val transition = rememberInfiniteTransition(label = "aurora")
    val drift by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(40_000, easing = LinearEasing)), label = "drift")

    Box(
        modifier
            .background(Brush.verticalGradient(listOf(Void, Nebula, Void)))
            .drawBehind {
                val w = size.width
                val h = size.height
                val turn: Float = drift * 2f * PI.toFloat()
                fun cloud(color: Color, x: Float, y: Float, r: Float) = drawCircle(
                    brush = Brush.radialGradient(listOf(color.copy(alpha = 0.30f), Color.Transparent), center = Offset(x, y), radius = r),
                    radius = r,
                    center = Offset(x, y)
                )
                cloud(a, w * (0.25f + 0.2f * sin(turn)), h * (0.25f + 0.1f * cos(turn * 2f)), w * 0.9f)
                cloud(b, w * (0.8f + 0.15f * cos(turn)), h * (0.55f + 0.12f * sin(turn)), w * 0.8f)
                cloud(c, w * (0.4f + 0.25f * sin(turn * 3f)), h * (0.9f + 0.05f * cos(turn)), w * 0.9f)
            }
    )
}
