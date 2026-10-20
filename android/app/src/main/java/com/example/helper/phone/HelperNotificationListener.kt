package com.example.helper.phone

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.service.notification.NotificationListenerService
import androidx.core.app.NotificationManagerCompat

/** Lets the phone agent read the notifications on screen ("מה ההתראות שלי"). Nothing is stored. */
class HelperNotificationListener : NotificationListenerService() {

    override fun onListenerConnected() {
        instance = this
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
    }

    companion object {
        @Volatile
        private var instance: HelperNotificationListener? = null

        fun enabled(context: Context) =
            NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)

        fun component(context: Context) = ComponentName(context, HelperNotificationListener::class.java)

        /** "WhatsApp: אבא — איפה אתה?" for each notification, newest first. */
        fun recent(context: Context, limit: Int = 15): String {
            val service = instance ?: return if (enabled(context)) "שירות ההתראות עוד לא התחבר" else "אין הרשאת גישה להתראות. אפשר לתת אותה במסך הראשי של HELPER."
            val pm = context.packageManager
            val items = service.activeNotifications.orEmpty()
                .filter { it.packageName != context.packageName }
                .sortedByDescending { it.postTime }
                .take(limit)
                .map { sbn ->
                    val app = runCatching { pm.getApplicationLabel(pm.getApplicationInfo(sbn.packageName, 0)).toString() }.getOrDefault(sbn.packageName)
                    val e = sbn.notification.extras
                    val title = e.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
                    val text = (e.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: e.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
                    "$app: $title${if (text.isNotBlank()) " — ${text.take(160)}" else ""}"
                }
            return if (items.isEmpty()) "אין התראות" else items.joinToString("\n")
        }
    }
}
