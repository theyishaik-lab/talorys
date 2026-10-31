package com.talorys.keyboard.keyboard

import android.text.InputType
import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FieldPolicyTest {
    private val text = InputType.TYPE_CLASS_TEXT

    @Test fun plainTextAutocorrectsAndLearns() {
        val p = FieldPolicy.of(text or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES, 0)
        assertTrue(p.autocorrect(true)); assertTrue(p.learning)
        assertFalse("setting off", p.autocorrect(false))
    }

    @Test fun neverInUrlEmailPasswordOrNumbers() {
        for (t in listOf(
            text or InputType.TYPE_TEXT_VARIATION_URI,
            text or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,
            text or InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS,
            text or InputType.TYPE_TEXT_VARIATION_PASSWORD,
            text or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
            text or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD,
            InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD,
            InputType.TYPE_CLASS_NUMBER, InputType.TYPE_CLASS_PHONE,
        )) {
            val p = FieldPolicy.of(t, 0)
            assertFalse("autocorrect $t", p.autocorrect(true))
            assertFalse("learning $t", p.learning)
        }
    }

    @Test fun appOptOuts() {
        assertFalse(FieldPolicy.of(text or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, 0).autocorrect(true))
        val incognito = FieldPolicy.of(text, EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING)
        assertFalse(incognito.learning)
        assertTrue(incognito.autocorrect(true))
    }
}
