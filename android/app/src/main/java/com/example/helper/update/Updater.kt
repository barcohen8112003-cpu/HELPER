package com.example.helper.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import com.example.helper.BuildConfig
import com.example.helper.R
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Keeps the app current without reinstalling by hand. GitHub Actions publishes each build with a small version.json
 * next to the APK; the app checks it a few times a day, downloads a newer APK, and installs it over itself.
 *
 * Nothing is installed unless the file's SHA-256 matches version.json AND it is signed with the same key as the
 * installed app, so a swapped or tampered download can never replace HELPER. From the second update on Android lets
 * the app update itself silently; the first one asks once, because the browser installed the app.
 */
object Updater {
    data class Release(val versionCode: Int, val versionName: String, val sha256: String, val url: String)

    private val state = MutableStateFlow("")
    val status: StateFlow<String> get() = state

    private val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build()
    private val lock = Mutex()
    private const val CHANNEL = "updates"
    private const val PREFS = "updater"

    /** version.json -> Release, or null when it is not one. */
    fun parse(json: String): Release? = runCatching {
        val o = JsonParser.parseString(json).asJsonObject
        Release(
            versionCode = o.get("versionCode").asInt,
            versionName = o.get("versionName")?.asString.orEmpty(),
            sha256 = o.get("sha256").asString.lowercase().also { require(it.matches(Regex("[0-9a-f]{64}"))) },
            url = o.get("url").asString.also { require(it.startsWith("https://")) },
        )
    }.getOrNull()

    fun isNewer(release: Release, installedCode: Long) = release.versionCode > installedCode

    /** Debug builds are the ones Android Studio installs; GitHub publishes release builds only. */
    val fromAndroidStudio get() = BuildConfig.DEBUG

    fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    @Suppress("DEPRECATION")
    private fun installedCode(context: Context): Long {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
    }

    fun installedName(context: Context): String =
        runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull() ?: "?"

    /** Android has to allow HELPER to install apps (once, in Settings) before it can update itself. */
    fun canInstall(context: Context) =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    fun installPermissionSettings(context: Context) =
        Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))

    /**
     * Checks once and installs a newer build if there is one. Returns a line for the settings screen.
     * [busy]: a phone task is running; the update waits for the next check rather than restart the app under it.
     */
    suspend fun check(context: Context, busy: Boolean = false): String = lock.withLock {
        // A build from Android Studio is signed with that computer's debug key: GitHub's builds could never install
        // over it, and Android Studio's own Run already updates it in place.
        if (fromAndroidStudio) return@withLock "הותקן מ-Android Studio: מתעדכן בלחיצה על Run".also { state.value = it }
        withContext(Dispatchers.IO) {
            val text = runCatching { checkNow(context.applicationContext, busy) }.getOrElse { "בדיקת עדכון נכשלה: ${it.message}" }
            state.value = text
            text
        }
    }

    private fun checkNow(context: Context, busy: Boolean): String {
        val manifest = client.newCall(Request.Builder().url(BuildConfig.UPDATE_URL).build()).execute().use { r ->
            if (r.code == 404) return "אין עדיין גרסה מפורסמת"
            if (!r.isSuccessful) throw IllegalStateException("שגיאה ${r.code}")
            r.body?.string().orEmpty()
        }
        val release = parse(manifest) ?: throw IllegalStateException("קובץ הגרסה לא תקין")
        if (!isNewer(release, installedCode(context))) return "מעודכן (גרסה ${installedName(context)})"
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getInt("refused", -1) == release.versionCode) return "גרסה ${release.versionName} חתומה במפתח אחר: צריך להתקין אותה פעם אחת ידנית"
        if (busy) return "גרסה ${release.versionName} מחכה לסוף המשימה"
        if (!canInstall(context)) return "יש גרסה ${release.versionName}. צריך לאשר ל-HELPER להתקין עדכונים"

        val apk = File(context.cacheDir, "update.apk")
        client.newCall(Request.Builder().url(release.url).build()).execute().use { r ->
            if (!r.isSuccessful) throw IllegalStateException("הורדה נכשלה (${r.code})")
            apk.outputStream().use { out -> r.body!!.byteStream().copyTo(out) }
        }
        if (sha256(apk) != release.sha256) {
            apk.delete()
            throw SecurityException("הקובץ שהורד לא תואם את הגרסה המפורסמת")
        }
        if (!sameSigner(context, apk)) {
            apk.delete()
            prefs.edit().putInt("refused", release.versionCode).apply()
            notify(context, "עדכון ל-HELPER דורש התקנה ידנית אחת", "הגרסה החדשה חתומה במפתח אחר מזה שמותקן. לחץ כדי להוריד ולהתקין.",
                Intent(Intent.ACTION_VIEW, Uri.parse(release.url)))
            return "גרסה ${release.versionName} חתומה במפתח אחר: צריך להתקין אותה פעם אחת ידנית"
        }
        install(context, apk)
        return "מתקין גרסה ${release.versionName}…"
    }

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo?): Set<String> = when {
        info == null -> emptySet()
        Build.VERSION.SDK_INT >= 28 -> info.signingInfo?.apkContentsSigners.orEmpty().map { it.toCharsString() }.toSet()
        else -> info.signatures.orEmpty().map { it.toCharsString() }.toSet()
    }

    @Suppress("DEPRECATION")
    private fun sameSigner(context: Context, apk: File): Boolean {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val mine = signers(pm.getPackageInfo(context.packageName, flags))
        val theirs = signers(pm.getPackageArchiveInfo(apk.path, flags))
        val archivePkg = pm.getPackageArchiveInfo(apk.path, 0)?.packageName
        return archivePkg == context.packageName && mine.isNotEmpty() && mine == theirs
    }

    private fun install(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    input.copyTo(out)
                    session.fsync(out)
                }
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            val done = PendingIntent.getBroadcast(context, id, Intent(context, UpdateReceiver::class.java), flags)
            session.commit(done.intentSender)
        }
    }

    internal fun notify(context: Context, title: String, text: String, open: Intent) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "עדכונים", NotificationManager.IMPORTANCE_DEFAULT))
        val pi = PendingIntent.getActivity(context, 7, open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        manager.notify(7, NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build())
    }

    internal fun report(text: String) {
        state.value = text
    }
}

/** Android's answer to an install: done, or "the user has to confirm this one" (the first self-update). */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                Updater.report("מחכה לאישור שלך להתקנה")
                runCatching { context.startActivity(Intent(confirm).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                Updater.notify(context, "עדכון ל-HELPER מוכן", "לחץ כדי להתקין. מהעדכון הבא זה יקרה לבד.", confirm)
            }
            PackageInstaller.STATUS_SUCCESS -> Updater.report("עודכן")
            else -> Updater.report("העדכון נכשל: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty()}")
        }
    }
}
