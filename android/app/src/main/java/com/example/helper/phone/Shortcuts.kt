package com.example.helper.phone

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings

/**
 * Direct ways to do common things, faster and surer than tapping through screens. None of them commits anything
 * the user would need to approve: dial, SMS and WhatsApp only open the screen with the text ready; pressing call or
 * send is a tap the server's gate checks.
 */
object Shortcuts {

    fun launch(context: Context, kind: String, args: Map<String, String>): String {
        val intent = when (kind) {
            "alarm" -> Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, args.int("hour") ?: throw IllegalArgumentException("חסרה שעה"))
                .putExtra(AlarmClock.EXTRA_MINUTES, args.int("minute") ?: 0)
                .putExtra(AlarmClock.EXTRA_MESSAGE, args["label"].orEmpty())
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            "timer" -> Intent(AlarmClock.ACTION_SET_TIMER)
                .putExtra(AlarmClock.EXTRA_LENGTH, args.int("seconds") ?: throw IllegalArgumentException("חסר משך"))
                .putExtra(AlarmClock.EXTRA_MESSAGE, args["label"].orEmpty())
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
            "calendar" -> {
                val begin = millis(args["begin"] ?: throw IllegalArgumentException("חסרה שעת התחלה"))
                val end = args["end"]?.let { millis(it) } ?: (begin + 3600_000)
                Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                    .putExtra(CalendarContract.Events.TITLE, args["title"].orEmpty())
                    .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin)
                    .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
                    .putExtra(CalendarContract.Events.EVENT_LOCATION, args["location"].orEmpty())
            }
            "contact" -> Intent(ContactsContract.Intents.Insert.ACTION)
                .setType(ContactsContract.RawContacts.CONTENT_TYPE)
                .putExtra(ContactsContract.Intents.Insert.NAME, args["name"].orEmpty())
                .putExtra(ContactsContract.Intents.Insert.PHONE, args["phone"].orEmpty())
            "dial" -> Intent(Intent.ACTION_DIAL, Uri.parse("tel:${Uri.encode(args["phone"].orEmpty())}"))
            "sms" -> Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:${Uri.encode(args["phone"].orEmpty())}"))
                .putExtra("sms_body", args["text"].orEmpty())
            "whatsapp" -> {
                val digits = args["phone"].orEmpty().filter { it.isDigit() }
                val uri = Uri.parse("https://wa.me/$digits?text=${Uri.encode(args["text"].orEmpty())}")
                Intent(Intent.ACTION_VIEW, uri).also { if (installed(context, WHATSAPP)) it.setPackage(WHATSAPP) }
            }
            "navigate" -> {
                val q = Uri.encode(args["query"] ?: throw IllegalArgumentException("חסר יעד"))
                if (installed(context, WAZE)) Intent(Intent.ACTION_VIEW, Uri.parse("waze://?q=$q&navigate=yes"))
                else Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=$q"))
            }
            "url" -> Intent(Intent.ACTION_VIEW, Uri.parse(args["url"] ?: throw IllegalArgumentException("חסרה כתובת")))
            "camera" -> Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)
            "settings" -> settingsPanel(args["panel"].orEmpty())
            else -> throw IllegalArgumentException("קיצור לא מוכר: $kind")
        }
        context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return when (kind) {
            "alarm" -> "השעון המעורר נקבע ל-%02d:%02d".format(args.int("hour"), args.int("minute") ?: 0)
            "timer" -> "טיימר הופעל ל-${args.int("seconds")} שניות"
            else -> ""
        }
    }

    private fun settingsPanel(panel: String) = when (panel) {
        "wifi" -> if (Build.VERSION.SDK_INT >= 29) Intent(Settings.Panel.ACTION_WIFI) else Intent(Settings.ACTION_WIFI_SETTINGS)
        "internet" -> if (Build.VERSION.SDK_INT >= 29) Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY) else Intent(Settings.ACTION_WIRELESS_SETTINGS)
        "volume" -> if (Build.VERSION.SDK_INT >= 29) Intent(Settings.Panel.ACTION_VOLUME) else Intent(Settings.ACTION_SOUND_SETTINGS)
        "bluetooth" -> Intent(Settings.ACTION_BLUETOOTH_SETTINGS)
        "display" -> Intent(Settings.ACTION_DISPLAY_SETTINGS)
        "battery" -> Intent(Settings.ACTION_BATTERY_SAVER_SETTINGS)
        "app" -> Intent(Settings.ACTION_APPLICATION_SETTINGS)
        else -> Intent(Settings.ACTION_SETTINGS)
    }

    /** Flashlight and volume are set directly; anything else is a settings screen the model opens and taps. */
    fun device(context: Context, setting: String, value: String): String = when (setting) {
        "flashlight", "torch", "פנס" -> {
            val cam = context.getSystemService(CameraManager::class.java)
            val id = cam.cameraIdList.firstOrNull { cam.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
                ?: throw IllegalStateException("אין פנס במכשיר")
            val on = value.lowercase() in setOf("on", "true", "1", "דלוק", "הדלק")
            cam.setTorchMode(id, on)
            if (on) "הפנס דלוק" else "הפנס כבוי"
        }
        "volume" -> {
            val audio = context.getSystemService(AudioManager::class.java)
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            val percent = value.filter { it.isDigit() }.toIntOrNull()?.coerceIn(0, 100) ?: throw IllegalArgumentException("חסר ערך 0-100")
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, max * percent / 100, 0)
            "עוצמת המדיה $percent%"
        }
        else -> throw IllegalArgumentException("הגדרה לא נתמכת ישירות: $setting. אפשר לפתוח אותה עם intent settings")
    }

    /** By package, or the installed app whose name best matches. */
    fun openApp(context: Context, pkg: String?, name: String?): String {
        val pm = context.packageManager
        val target = pkg?.takeIf { pm.getLaunchIntentForPackage(it) != null } ?: name?.let { findByName(context, it) }
            ?: throw IllegalArgumentException("לא מצאתי אפליקציה ${name ?: pkg}")
        val intent = pm.getLaunchIntentForPackage(target)!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        context.startActivity(intent)
        return "נפתח $target"
    }

    private fun findByName(context: Context, name: String): String? {
        val pm = context.packageManager
        val q = name.trim().lowercase()
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
            .map { it.activityInfo.packageName to it.loadLabel(pm).toString().lowercase() }
        return (apps.firstOrNull { it.second == q } ?: apps.firstOrNull { it.second.startsWith(q) } ?: apps.firstOrNull { it.second.contains(q) || it.first.contains(q) })?.first
    }

    private fun installed(context: Context, pkg: String) = try {
        context.packageManager.getPackageInfo(pkg, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    // minSdk 24 has no java.time without desugaring.
    private fun millis(local: String) =
        java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm", java.util.Locale.US).parse(local.take(16))?.time
            ?: throw IllegalArgumentException("תאריך לא תקין: $local")

    private fun Map<String, String>.int(k: String) = this[k]?.trim()?.toDoubleOrNull()?.toInt()

    private const val WHATSAPP = "com.whatsapp"
    private const val WAZE = "com.waze"
}
