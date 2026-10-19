package com.example.helper

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import com.example.helper.data.SettingsRepository
import com.example.helper.ui.screens.ChatScreen
import com.example.helper.ui.screens.MainScreen
import com.example.helper.ui.screens.SettingsScreen
import com.example.helper.ui.theme.HelperTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Light icons on the dark background, with the bars see-through.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT)
        )
        setContent {
            HelperTheme {
                HelperApp()
            }
        }
    }
}

@Composable
fun HelperApp() {
    val context = LocalContext.current
    val settingsRepo = remember { SettingsRepository.getInstance(context) }
    var currentScreen by remember {
        mutableStateOf(if (settingsRepo.hasConnectionDetails()) "chat" else "settings")
    }

    // Back from the voice screen or settings returns to the chat instead of closing the app.
    BackHandler(enabled = currentScreen != "chat" && settingsRepo.hasConnectionDetails()) { currentScreen = "chat" }

    when (currentScreen) {
        "settings" -> SettingsScreen(onSettingsComplete = { currentScreen = "chat" })
        "voice" -> MainScreen(
            settingsRepository = settingsRepo,
            onNavigateToSettings = { currentScreen = "settings" },
            onOpenChat = { currentScreen = "chat" }
        )
        else -> ChatScreen(
            settingsRepository = settingsRepo,
            onOpenVoice = { currentScreen = "voice" },
            onOpenSettings = { currentScreen = "settings" }
        )
    }
}
