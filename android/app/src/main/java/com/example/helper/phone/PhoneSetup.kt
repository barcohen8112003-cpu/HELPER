package com.example.helper.phone

import android.annotation.SuppressLint
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/** The three things phone control needs from Android, each with the screen where the user turns it on. */
object PhoneSetup {

    fun accessibilityOn(context: Context): Boolean {
        val me = ComponentName(context, HelperAccessibilityService::class.java).flattenToString()
        val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
        return enabled.split(':').any { it.equals(me, ignoreCase = true) }
    }

    fun notificationsOn(context: Context) = HelperNotificationListener.enabled(context)

    fun batteryFree(context: Context) =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    fun accessibilitySettings() = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)

    /** Android 13+ blocks accessibility for apps installed from a file until "restricted settings" are allowed here. */
    fun appInfo(context: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))

    fun notificationSettings(context: Context): Intent =
        if (Build.VERSION.SDK_INT >= 30) {
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, HelperNotificationListener.component(context).flattenToString())
        } else {
            Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
        }

    @SuppressLint("BatteryLife")
    fun batterySettings(context: Context) =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
}
