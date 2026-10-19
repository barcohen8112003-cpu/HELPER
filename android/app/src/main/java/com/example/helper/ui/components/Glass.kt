package com.example.helper.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.example.helper.ui.theme.Cyan
import com.example.helper.ui.theme.Pink
import com.example.helper.ui.theme.Violet

/** A frosted panel: a faint fill with a rim that is brighter at the top, like glass catching light. */
@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    corner: Dp = 24.dp,
    padding: Dp = 16.dp,
    content: @Composable () -> Unit
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(corner),
        color = Color.White.copy(alpha = 0.07f),
        border = BorderStroke(1.dp, Brush.linearGradient(listOf(Color.White.copy(alpha = 0.30f), Color.White.copy(alpha = 0.04f))))
    ) {
        Box(Modifier.padding(padding)) { content() }
    }
}

/** Text painted with the brand gradient. */
val GradientText = TextStyle(brush = Brush.linearGradient(listOf(Cyan, Violet, Pink)))
