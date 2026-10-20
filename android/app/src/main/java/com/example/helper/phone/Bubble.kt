package com.example.helper.phone

import android.accessibilityservice.AccessibilityService
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The small pill at the top of the screen while HELPER works the phone: what it is doing now, in Hebrew, and a stop
 * button. An accessibility overlay, so it needs no "draw over other apps" permission and the agent's own screen
 * reading leaves it out.
 */
class Bubble(private val service: AccessibilityService, private val onStop: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val wm = service.getSystemService(WindowManager::class.java)
    private var view: LinearLayout? = null
    private var label: TextView? = null
    private val hide = Runnable { remove() }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), service.resources.displayMetrics).toInt()

    fun show(text: String) = main.post {
        main.removeCallbacks(hide)
        if (view == null) create()
        label?.text = text
    }

    /** Shows the last line for a moment, then goes away. */
    fun finish(text: String) = main.post {
        if (view == null) create()
        label?.text = text
        main.removeCallbacks(hide)
        main.postDelayed(hide, 4000)
    }

    private fun create() {
        val pill = GradientDrawable().apply {
            cornerRadius = dp(24).toFloat()
            setColor(Color.parseColor("#E6141022"))
            setStroke(dp(1), Color.parseColor("#998B5CF6"))
        }
        val text = TextView(service).apply {
            setTextColor(Color.WHITE)
            textSize = 14f
            maxLines = 1
            setPadding(dp(16), dp(10), dp(8), dp(10))
        }
        val stop = TextView(service).apply {
            this.text = "עצור"
            setTextColor(Color.parseColor("#FF8FA3"))
            typeface = Typeface.DEFAULT_BOLD
            textSize = 14f
            setPadding(dp(12), dp(10), dp(16), dp(10))
            setOnClickListener {
                onStop()
                finish("עוצר…")
            }
        }
        val row = LinearLayout(service).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutDirection = View.LAYOUT_DIRECTION_RTL
            background = pill
            addView(text)
            addView(stop)
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(40)
        }
        runCatching { wm.addView(row, params) }.onSuccess {
            view = row
            label = text
        }
    }

    fun remove() = main.post {
        view?.let { runCatching { wm.removeView(it) } }
        view = null
        label = null
    }
}
