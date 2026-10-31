package com.talorys.keyboard.keyboard

import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.HapticFeedbackConstants
import android.view.View

/**
 * Key-press feedback, fired on touch-DOWN so it feels instant.
 *
 * Haptics: strength 0 = off; 1..[MAX_STRENGTH] = a short one-shot vibration of increasing length
 * (Gboard style, works even when the system's "touch feedback" setting is off), with the
 * hardware's crisp predefined "tick" for the lightest step on Android 10+. [useSystem] instead
 * asks the view for KEYBOARD_TAP (follows the system haptics setting).
 * Sound: the system key-click sounds at [soundVolume] (0..1), off by default.
 */
class Feedback(context: Context) {

    private val vibrator: Vibrator? = runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Vibrator::class.java)
        }
    }.getOrNull()?.takeIf { it.hasVibrator() }

    private val audio: AudioManager? = context.getSystemService(AudioManager::class.java)

    var strength: Int = DEFAULT_STRENGTH
        set(v) { field = v.coerceIn(0, MAX_STRENGTH); effect = buildEffect(field) }
    var useSystem: Boolean = false
    var sound: Boolean = false
    var soundVolume: Float = 0.5f

    private var effect: VibrationEffect? = buildEffect(strength)

    private fun buildEffect(s: Int): VibrationEffect? {
        if (s <= 0) return null
        if (s == 1 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)
        return VibrationEffect.createOneShot(durationFor(s), VibrationEffect.DEFAULT_AMPLITUDE)
    }

    /** One key press. [view] is used for the system haptic path. */
    fun keyDown(view: View, code: Int) {
        val vib = vibrator
        if (strength > 0) {
            if (useSystem || vib == null) {
                @Suppress("DEPRECATION")
                view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP, HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING)
            } else {
                effect?.let { runCatching { vib.vibrate(it) } }
            }
        }
        if (sound) {
            val fx = when (code) {
                Codes.DELETE -> AudioManager.FX_KEYPRESS_DELETE
                Codes.SPACE -> AudioManager.FX_KEYPRESS_SPACEBAR
                Codes.ENTER -> AudioManager.FX_KEYPRESS_RETURN
                else -> AudioManager.FX_KEYPRESS_STANDARD
            }
            runCatching { audio?.playSoundEffect(fx, soundVolume) }
        }
    }

    /** A lighter tick for repeated / continuous actions (cursor slide steps, word-delete steps). */
    fun tick(view: View) {
        if (strength <= 0) return
        val vib = vibrator
        if (useSystem || vib == null) {
            view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            runCatching { vib.vibrate(VibrationEffect.createPredefined(VibrationEffect.EFFECT_TICK)) }
        } else {
            runCatching { vib.vibrate(VibrationEffect.createOneShot(4, VibrationEffect.DEFAULT_AMPLITUDE)) }
        }
    }

    companion object {
        const val MAX_STRENGTH = 5
        const val DEFAULT_STRENGTH = 2
        fun durationFor(strength: Int): Long = when (strength) {
            1 -> 5L
            2 -> 9L
            3 -> 14L
            4 -> 20L
            else -> 28L
        }
    }
}
