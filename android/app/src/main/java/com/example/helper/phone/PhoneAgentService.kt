package com.example.helper.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.example.helper.MainActivity
import com.example.helper.R

/**
 * The persistent "HELPER שולט בטלפון" notification, with a stop button. It keeps the app's process in the foreground
 * so Samsung does not freeze the phone link; the accessibility service does the actual work.
 */
class PhoneAgentService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_TASK) {
            HelperAccessibilityService.instance?.requestStop()
            return START_STICKY
        }
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "שליטה בטלפון", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, PhoneAgentService::class.java).setAction(ACTION_STOP_TASK), PendingIntent.FLAG_IMMUTABLE)
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("HELPER שולט בטלפון")
            .setContentText("מחכה למשימה. \"עצור\" עוצר משימה שרצה.")
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "עצור", stop)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(ID, notification)
        } catch (_: Exception) {
            // Not allowed from here right now; the accessibility service keeps working without the notification.
            stopSelf()
        }
        return START_STICKY
    }

    companion object {
        private const val CHANNEL = "phone_agent"
        private const val ID = 4207
        private const val ACTION_STOP_TASK = "com.example.helper.phone.STOP_TASK"

        fun start(context: Context) {
            runCatching {
                val intent = Intent(context, PhoneAgentService::class.java)
                if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
            }
        }

        fun stop(context: Context) {
            runCatching { context.stopService(Intent(context, PhoneAgentService::class.java)) }
        }
    }
}
