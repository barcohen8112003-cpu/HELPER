package com.example.helper.phone

import android.content.Context
import android.os.Build
import android.util.Log
import com.example.helper.data.SettingsRepository
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * The phone's line to the HELPER server: one WebSocket to /bridge/phone, dialled out with the app's bridge token, so
 * it works on Wi-Fi and mobile data and nothing on the phone accepts connections. Reconnects on its own, with a
 * growing pause, for as long as the accessibility service runs.
 */
class PhoneLink(private val context: Context, private val onMessage: (JsonObject) -> Unit) {
    enum class State { OFF, CONNECTING, CONNECTED, NO_SETTINGS }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val gson = Gson()
    private var socket: WebSocket? = null
    private var running = false
    private var backoff = 2000L
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    fun start() {
        if (running) return
        running = true
        connect()
    }

    fun stop() {
        running = false
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "bye")
        socket = null
        state.value = State.OFF
    }

    fun send(map: Map<String, Any?>) {
        socket?.send(gson.toJson(map))
    }

    private fun retry() {
        if (!running) return
        handler.postDelayed({ connect() }, backoff)
        backoff = (backoff * 2).coerceAtMost(60_000)
    }

    private fun connect() {
        if (!running) return
        val settings = SettingsRepository.getInstance(context)
        val base = settings.getUrl()?.trim()?.removeSuffix("/")
        val token = settings.getToken()?.trim()
        if (base.isNullOrEmpty() || token.isNullOrEmpty()) {
            state.value = State.NO_SETTINGS
            backoff = 30_000
            return retry()
        }
        val url = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> "ws://$base"
        } + "/bridge/phone"
        state.value = State.CONNECTING
        val request = Request.Builder().url(url).addHeader("Authorization", "Bearer $token").build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                backoff = 2000
                state.value = State.CONNECTED
                webSocket.send(gson.toJson(mapOf(
                    "type" to "hello",
                    "device" to "${Build.MANUFACTURER} ${Build.MODEL} (Android ${Build.VERSION.RELEASE})",
                    "perms" to mapOf(
                        "accessibility" to true,
                        "notifications" to HelperNotificationListener.enabled(context),
                        "battery" to PhoneSetup.batteryFree(context),
                    ),
                )))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { JsonParser.parseString(text).asJsonObject }.getOrNull() ?: return
                onMessage(msg)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(webSocket)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "link failed: ${t.message}")
                dropped(webSocket)
            }
        })
    }

    private fun dropped(ws: WebSocket) {
        if (socket !== ws) return
        socket = null
        if (running) state.value = State.CONNECTING
        retry()
    }

    companion object {
        private const val TAG = "HelperPhoneLink"
        val state = MutableStateFlow(State.OFF)
        val status: StateFlow<State> get() = state
    }
}
