package com.example.helper.wake

/**
 * Which on-device listener to run. Porcupine when the owner pasted an AccessKey and has either a custom
 * keyword file or the built-in English "Jarvis". Otherwise the phone's own offline recognizer, which stays
 * off the network: a result that required the cloud stops the listener.
 * A Hebrew .ppn needs the Hebrew .pv model. That model does not contain Jarvis, so Jarvis is not added beside it.
 */
enum class WakeEngine { PORCUPINE, OFFLINE }

data class WakeChoice(
    val engine: WakeEngine,
    val customKeyword: Boolean,
    val customModel: Boolean,
    val jarvis: Boolean
)

fun chooseWake(accessKey: String, hasKeyword: Boolean, hasModel: Boolean, jarvis: Boolean): WakeChoice {
    val key = accessKey.isNotBlank()
    val jarvisOk = jarvis && !hasModel
    if (key && (hasKeyword || jarvisOk)) {
        return WakeChoice(WakeEngine.PORCUPINE, customKeyword = hasKeyword, customModel = hasModel, jarvis = jarvisOk)
    }
    return WakeChoice(WakeEngine.OFFLINE, customKeyword = false, customModel = false, jarvis = false)
}
