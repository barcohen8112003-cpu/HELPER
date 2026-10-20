package com.example.helper.ui.screens

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.example.helper.assistant.AssistantStatus
import com.example.helper.chat.ChatController
import com.example.helper.data.SettingsRepository
import com.example.helper.network.HelperApiService
import com.example.helper.phone.PhoneLink
import com.example.helper.phone.PhoneSetup
import com.example.helper.phone.HelperAccessibilityService
import com.example.helper.update.Updater
import kotlinx.coroutines.launch
import com.example.helper.ui.components.AuroraBackground
import com.example.helper.ui.components.GlassCard
import com.example.helper.ui.components.GradientText
import com.example.helper.ui.components.HelperOrb
import com.example.helper.ui.theme.Cyan
import com.example.helper.ui.theme.Mint
import com.example.helper.ui.theme.Pink
import com.example.helper.ui.theme.TextHigh
import com.example.helper.ui.theme.TextLow
import com.example.helper.ui.theme.TextMid
import com.example.helper.ui.theme.Violet
import com.example.helper.voice.Phase
import com.example.helper.voice.VoiceEngine
import com.example.helper.wake.WakeAccess
import com.example.helper.wake.WakeWordService

@Composable
fun MainScreen(
    settingsRepository: SettingsRepository,
    onNavigateToSettings: () -> Unit,
    onOpenChat: (() -> Unit)? = null
) {
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val engine = remember { VoiceEngine(context, HelperApiService(settingsRepository)) }
    val state by engine.state.collectAsState()

    DisposableEffect(engine) {
        // What is said by voice joins the same conversation as the typed chat.
        engine.onExchange = { heard, reply -> ChatController.get(context).addExchange(heard, reply) }
        onDispose { engine.release() }
    }

    // Whether this app is the phone's assistant can change while the app is in the background (in Settings).
    var isDefaultAssistant by remember { mutableStateOf(AssistantStatus.isDefault(context)) }
    var canOverlay by remember { mutableStateOf(WakeAccess.canOverlay(context)) }
    var batteryFree by remember { mutableStateOf(WakeAccess.batteryFree(context)) }
    var phoneAccess by remember { mutableStateOf(PhoneSetup.accessibilityOn(context)) }
    var phoneNotifications by remember { mutableStateOf(PhoneSetup.notificationsOn(context)) }
    var canInstallUpdates by remember { mutableStateOf(Updater.canInstall(context)) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                isDefaultAssistant = AssistantStatus.isDefault(context)
                canOverlay = WakeAccess.canOverlay(context)
                batteryFree = WakeAccess.batteryFree(context)
                phoneAccess = PhoneSetup.accessibilityOn(context)
                phoneNotifications = PhoneSetup.notificationsOn(context)
                canInstallUpdates = Updater.canInstall(context)
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    var micGranted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
    }
    var wakeEnabled by remember { mutableStateOf(settingsRepository.isWakeWordEnabled()) }
    // The listener keeps running after the app is closed; opening the app brings it back after a reboot.
    LaunchedEffect(Unit) { if (wakeEnabled && micGranted) WakeWordService.start(context) }

    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        micGranted = granted
        if (granted) engine.startConversation()
    }
    val wakePermissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        val mic = result[Manifest.permission.RECORD_AUDIO] ?: micGranted
        micGranted = mic
        if (mic) {
            settingsRepository.setWakeWordEnabled(true)
            wakeEnabled = true
            WakeWordService.start(context)
        }
    }

    val tapOrb = {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        when {
            !micGranted -> micLauncher.launch(Manifest.permission.RECORD_AUDIO)
            // A tap starts a hands-free conversation; a tap during one ends it.
            state.conversation -> engine.endConversation("סיימנו. לחץ על הכדור כדי להתחיל שוב")
            else -> engine.startConversation()
        }
    }

    Box(Modifier.fillMaxSize()) {
        AuroraBackground(state.phase, Modifier.fillMaxSize())

        // The column scrolls on small screens, but on a tall one it is at least as high as the screen, so the
        // cards at the bottom sit at the bottom instead of right under the orb.
        BoxWithConstraints(Modifier.fillMaxSize().systemBarsPadding()) {
        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(min = maxHeight)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // ── header ──────────────────────────────────────────────────────
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (onOpenChat != null) {
                    Box(
                        Modifier
                            .size(40.dp)
                            .clip(CircleShape)
                            .background(Color.White.copy(alpha = 0.08f))
                            .clickable { onOpenChat() },
                        contentAlignment = Alignment.Center
                    ) { Text("💬", color = TextHigh, fontSize = 17.sp) }
                    Spacer(Modifier.size(8.dp))
                }
                ConnectionChip(settingsRepository.hasConnectionDetails())
                Spacer(Modifier.weight(1f))
                Text(
                    text = "HELPER",
                    style = GradientText,
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 4.sp
                )
                Spacer(Modifier.weight(1f))
                Box(
                    Modifier
                        .size(40.dp)
                        .clip(CircleShape)
                        .background(Color.White.copy(alpha = 0.08f))
                        .clickable { onNavigateToSettings() },
                    contentAlignment = Alignment.Center
                ) { Text("⚙", color = TextHigh, fontSize = 18.sp) }
            }

            Spacer(Modifier.height(8.dp))

            // ── the orb ─────────────────────────────────────────────────────
            HelperOrb(phase = state.phase, level = state.level, size = 340.dp, onClick = tapOrb)

            Text(
                text = headline(state.phase, micGranted, state.conversation),
                color = TextHigh,
                fontSize = 22.sp,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = subline(state.phase, isDefaultAssistant, state.conversation),
                color = TextLow,
                fontSize = 14.sp,
                textAlign = TextAlign.Center
            )

            Spacer(Modifier.height(18.dp))

            // ── what was heard, and the answer ──────────────────────────────
            val heardLine = if (state.phase == Phase.Listening) state.partial else state.heard
            AnimatedVisibility(
                visible = heardLine.isNotBlank(),
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically()
            ) {
                Text(
                    text = "“$heardLine”",
                    color = TextMid,
                    fontSize = 16.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(bottom = 12.dp)
                )
            }

            AnimatedVisibility(
                visible = state.reply.isNotBlank(),
                enter = fadeIn() + expandVertically(),
                exit = fadeOut() + shrinkVertically()
            ) {
                GlassCard(Modifier.fillMaxWidth().animateContentSize()) {
                    Column {
                        Text(state.reply, color = TextHigh, fontSize = 18.sp, lineHeight = 27.sp)
                        Spacer(Modifier.height(10.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                text = when {
                                    state.phase == Phase.Speaking && state.ownVoice -> "🔊 בקול של העוזר"
                                    state.phase == Phase.Speaking -> "🔊 בקול של הטלפון"
                                    else -> "🔈 הקרא שוב"
                                },
                                color = Cyan,
                                fontSize = 13.sp,
                                modifier = Modifier.clickable {
                                    if (state.phase == Phase.Speaking) engine.stopSpeech() else engine.replay()
                                }
                            )
                        }
                    }
                }
            }

            state.note?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, color = if (state.phase == Phase.Error) Pink else TextLow, fontSize = 13.sp, textAlign = TextAlign.Center)
            }

            Spacer(Modifier.weight(1f, fill = true))
            Spacer(Modifier.height(20.dp))

            // ── making it the phone's assistant ─────────────────────────────
            AssistantCard(
                isDefault = isDefaultAssistant,
                onChoose = {
                    try {
                        context.startActivity(AssistantStatus.settingsIntent())
                    } catch (e: ActivityNotFoundException) {
                        try {
                            context.startActivity(AssistantStatus.fallbackSettingsIntent())
                        } catch (_: ActivityNotFoundException) {
                        }
                    }
                }
            )

            Spacer(Modifier.height(12.dp))

            val wakeStatus by WakeWordService.status.collectAsState()
            WakeCard(
                enabled = wakeEnabled,
                status = wakeStatus,
                canOverlay = canOverlay,
                batteryFree = batteryFree,
                onFix = { intent -> try { context.startActivity(intent) } catch (_: ActivityNotFoundException) {} },
                onChange = { on ->
                    if (!on) {
                        settingsRepository.setWakeWordEnabled(false)
                        wakeEnabled = false
                        WakeWordService.stop(context)
                    } else {
                        val needed = buildList {
                            add(Manifest.permission.RECORD_AUDIO)
                            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
                        }
                        wakePermissions.launch(needed.toTypedArray())
                    }
                }
            )
            Spacer(Modifier.height(12.dp))

            // ── phone control ───────────────────────────────────────────────
            val linkState by PhoneLink.status.collectAsState()
            PhoneControlCard(
                accessibility = phoneAccess,
                notifications = phoneNotifications,
                batteryFree = batteryFree,
                link = linkState,
                onOpen = { intent -> try { context.startActivity(intent) } catch (_: ActivityNotFoundException) {} },
            )
            Spacer(Modifier.height(12.dp))

            // ── updates from GitHub ─────────────────────────────────────────
            val updateStatus by Updater.status.collectAsState()
            val updateScope = rememberCoroutineScope()
            UpdateCard(
                version = Updater.installedName(context),
                status = updateStatus,
                canInstall = canInstallUpdates,
                onAllow = { try { context.startActivity(Updater.installPermissionSettings(context)) } catch (_: ActivityNotFoundException) {} },
                onCheck = { updateScope.launch { Updater.check(context, HelperAccessibilityService.instance?.busy == true) } },
            )
            Spacer(Modifier.height(20.dp))
        }
        }
    }
}

private fun headline(phase: Phase, micGranted: Boolean, conversation: Boolean) = when {
    !micGranted -> "בוא נתחיל"
    phase == Phase.Listening -> "מקשיב..."
    phase == Phase.Thinking -> "חושב..."
    phase == Phase.Speaking -> "מדבר..."
    phase == Phase.Error -> "משהו השתבש"
    conversation -> "אני איתך"
    else -> "היי, אני HELPER"
}

private fun subline(phase: Phase, isDefault: Boolean, conversation: Boolean) = if (conversation) {
    "שיחה פעילה: פשוט דבר. כדי לסיים אמור \"תודה\" או לחץ על הכדור"
} else when (phase) {
    Phase.Idle -> if (isDefault) "לחץ על הכדור, או לחיצה ארוכה על כפתור ההפעלה" else "לחץ על הכדור ודבר איתי"
    Phase.Listening -> "לחץ שוב כשסיימת"
    Phase.Thinking -> "לחץ כדי לבטל"
    Phase.Speaking -> "לחץ כדי להשתיק"
    Phase.Error -> "לחץ על הכדור כדי לנסות שוב"
}

@Composable
private fun ConnectionChip(connected: Boolean) {
    Row(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(Color.White.copy(alpha = 0.08f))
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (connected) Mint else Pink))
        Spacer(Modifier.size(6.dp))
        Text(if (connected) "מחובר" else "לא מחובר", color = TextMid, fontSize = 12.sp)
    }
}

@Composable
private fun AssistantCard(isDefault: Boolean, onChoose: () -> Unit) {
    GlassCard(Modifier.fillMaxWidth().clickable(enabled = !isDefault) { onChoose() }) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(Brush.linearGradient(listOf(Violet, Cyan))),
                contentAlignment = Alignment.Center
            ) { Text(if (isDefault) "✓" else "⏻", color = Color.White, fontSize = 20.sp) }
            Spacer(Modifier.size(14.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (isDefault) "HELPER הוא העוזר הקולי של הטלפון" else "הפוך את HELPER לעוזר הקולי",
                    color = TextHigh,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 16.sp
                )
                Text(
                    if (isDefault) "לחיצה ארוכה על כפתור ההפעלה פותחת אותו" else "כך הוא ייפתח בלחיצה ארוכה על כפתור ההפעלה. לחץ כאן ובחר HELPER",
                    color = TextLow,
                    fontSize = 12.sp
                )
            }
        }
    }
}

@Composable
private fun WakeCard(
    enabled: Boolean,
    status: String,
    canOverlay: Boolean,
    batteryFree: Boolean,
    onFix: (android.content.Intent) -> Unit,
    onChange: (Boolean) -> Unit
) {
    val context = LocalContext.current
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("אמור \"היי בוט\"", color = TextHigh, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    Text("ניסיוני: ההאזנה פועלת ברקע, גם כשהאפליקציה סגורה, וצורכת סוללה", color = TextLow, fontSize = 12.sp)
                    if (enabled && status.isNotBlank()) Text(status, color = Cyan, fontSize = 12.sp)
                }
                Switch(
                    checked = enabled,
                    onCheckedChange = onChange,
                    colors = SwitchDefaults.colors(checkedTrackColor = Violet, checkedThumbColor = Color.White)
                )
            }
            // Without these, saying the phrase while the app is closed only shows a notification.
            if (enabled && !canOverlay) {
                WakeFix("אפשר הופעה מעל אפליקציות אחרות", "כדי שהחלון ייפתח לבד מעל כל מסך") {
                    onFix(WakeAccess.overlaySettings(context))
                }
            }
            if (enabled && !batteryFree) {
                WakeFix("בטל הגבלת סוללה", "אחרת סמסונג מרדימה את ההאזנה אחרי זמן מה") {
                    onFix(WakeAccess.batterySettings(context))
                }
            }
        }
    }
}

/** Setup for phone control: one row per Android permission, a green check once it is on. */
@Composable
private fun PhoneControlCard(
    accessibility: Boolean,
    notifications: Boolean,
    batteryFree: Boolean,
    link: PhoneLink.State,
    onOpen: (android.content.Intent) -> Unit,
) {
    val context = LocalContext.current
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            Text("שליטה בטלפון", color = TextHigh, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
            Text("HELPER מבצע בטלפון משימות שביקשת בוואטסאפ, ומבקש אישור לפני תשלום, שליחה או שיחה", color = TextLow, fontSize = 12.sp)
            val linkText = when {
                !accessibility -> ""
                link == PhoneLink.State.CONNECTED -> "מחובר לשרת"
                link == PhoneLink.State.NO_SETTINGS -> "חסרים כתובת וקוד חיבור (סרוק את קוד ה-QR)"
                else -> "מתחבר לשרת…"
            }
            if (linkText.isNotEmpty()) Text(linkText, color = if (link == PhoneLink.State.CONNECTED) Mint else Cyan, fontSize = 12.sp)
            PhoneStep("שירות נגישות", "הגדרות ← נגישות ← אפליקציות מותקנות ← HELPER", accessibility) { onOpen(PhoneSetup.accessibilitySettings()) }
            if (!accessibility) {
                PhoneStep("אם האפשרות אפורה", "פרטי האפליקציה ← ⋮ ← \"אפשר הגדרות מוגבלות\", ואז שוב נגישות", false) { onOpen(PhoneSetup.appInfo(context)) }
            }
            PhoneStep("גישה להתראות", "כדי שיוכל לקרוא לך את ההתראות", notifications) { onOpen(PhoneSetup.notificationSettings(context)) }
            PhoneStep("ללא הגבלת סוללה", "אחרת סמסונג מנתקת אותו ברקע", batteryFree) { onOpen(PhoneSetup.batterySettings(context)) }
        }
    }
}

/** The app's version, and whether it can update itself from GitHub. */
@Composable
private fun UpdateCard(version: String, status: String, canInstall: Boolean, onAllow: () -> Unit, onCheck: () -> Unit) {
    GlassCard(Modifier.fillMaxWidth()) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("עדכונים", color = TextHigh, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    Text("גרסה $version. האפליקציה מתעדכנת לבד מ-GitHub, בלי להתקין מחדש", color = TextLow, fontSize = 12.sp)
                    if (status.isNotBlank()) Text(status, color = Cyan, fontSize = 12.sp)
                }
                Text(
                    "בדוק עכשיו",
                    color = Cyan,
                    fontSize = 13.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clip(RoundedCornerShape(12.dp)).clickable(onClick = onCheck).padding(8.dp),
                )
            }
            PhoneStep("לאפשר התקנת עדכונים", "פעם אחת: \"אפשר ממקור זה\" עבור HELPER", canInstall, onAllow)
        }
    }
}

@Composable
private fun PhoneStep(title: String, detail: String, done: Boolean, onClick: () -> Unit) {
    Spacer(Modifier.height(10.dp))
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(if (done) Mint.copy(alpha = 0.12f) else Pink.copy(alpha = 0.14f))
            .clickable(enabled = !done, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = TextHigh, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
            if (!done) Text(detail, color = TextLow, fontSize = 12.sp)
        }
        Text(if (done) "✓" else "←", color = if (done) Mint else TextLow, fontSize = 18.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun WakeFix(title: String, detail: String, onClick: () -> Unit) {
    Spacer(Modifier.height(10.dp))
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Pink.copy(alpha = 0.14f))
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp)
    ) {
        Text(title, color = TextHigh, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
        Text(detail, color = TextLow, fontSize = 12.sp)
    }
}
