package com.example.helper.wake

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * What the wake phrase needs from Android to open the overlay while HELPER is closed: permission to appear over
 * other apps, and no battery restriction (Samsung otherwise puts the listener to sleep after a while).
 */
object WakeAccess {
    fun canOverlay(context: Context) = Settings.canDrawOverlays(context)

    fun batteryFree(context: Context) =
        context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)

    fun overlaySettings(context: Context) =
        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))

    @SuppressLint("BatteryLife")
    fun batterySettings(context: Context) =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
}
