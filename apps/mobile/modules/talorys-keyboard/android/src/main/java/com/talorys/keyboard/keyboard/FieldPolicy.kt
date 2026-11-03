package com.talorys.keyboard.keyboard

import android.text.InputType
import android.view.inputmethod.EditorInfo

/** What the word engine may do in a field, from its EditorInfo input type and options (unit-tested). */
data class FieldPolicy(
    val password: Boolean,
    val email: Boolean,
    val uri: Boolean,
    val noSuggestions: Boolean,
    val noPersonalizedLearning: Boolean,
    val numeric: Boolean,
) {
    /** Glide, suggestions, prediction: ordinary text only. */
    val wordFeatures: Boolean get() = !password && !email && !uri && !numeric

    /** Never in URL, email, password or numeric fields, nor where the app asks for no suggestions. */
    fun autocorrect(setting: Boolean): Boolean = setting && wordFeatures && !noSuggestions

    /** Never from password / email / URL fields or apps that ask for no personalised learning (incognito). */
    val learning: Boolean get() = wordFeatures && !noPersonalizedLearning

    companion object {
        fun of(inputType: Int, imeOptions: Int): FieldPolicy {
            val cls = inputType and InputType.TYPE_MASK_CLASS
            val variation = inputType and InputType.TYPE_MASK_VARIATION
            val text = cls == InputType.TYPE_CLASS_TEXT
            val password = (text && (variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)) ||
                (cls == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
            return FieldPolicy(
                password = password,
                email = text && (variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS || variation == InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS),
                uri = text && variation == InputType.TYPE_TEXT_VARIATION_URI,
                noSuggestions = text && ((inputType and InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS) != 0 || variation == InputType.TYPE_TEXT_VARIATION_FILTER),
                noPersonalizedLearning = (imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING) != 0,
                numeric = cls == InputType.TYPE_CLASS_NUMBER || cls == InputType.TYPE_CLASS_PHONE || cls == InputType.TYPE_CLASS_DATETIME,
            )
        }
    }
}
