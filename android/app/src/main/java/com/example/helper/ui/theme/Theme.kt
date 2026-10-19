package com.example.helper.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection

private val HelperColors = darkColorScheme(
    primary = Violet,
    secondary = Cyan,
    tertiary = Pink,
    background = Void,
    surface = Nebula,
    onPrimary = TextHigh,
    onSecondary = Void,
    onBackground = TextHigh,
    onSurface = TextHigh,
    error = Red
)

// The app is always dark: the orb only looks right against a deep background. It is also always right to left.
@Composable
fun HelperTheme(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
        MaterialTheme(
            colorScheme = HelperColors,
            typography = Typography,
            content = content
        )
    }
}
