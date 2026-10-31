package com.talorys.keyboard

import com.talorys.keyboard.screen.ScreenPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode

/**
 * The bridge the app's React Native Settings → Keyboard screen uses (0.4.0): preferences land in
 * the keyboard's own SharedPreferences, bad values are ignored, and the app's session becomes the
 * keyboard's (one login).
 */
@RunWith(RobolectricTestRunner::class)
// Legacy modes: Robolectric's native runtime does not exist for Linux aarch64 (Hark's build host).
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
@Config(sdk = [35])
class KeyboardBridgeTest {
    private val ctx get() = RuntimeEnvironment.getApplication()

    @Test fun preferencesRoundTripAndLandInUiPrefs() {
        val out = KeyboardBridge.setPreferences(
            ctx,
            mapOf(
                "keyHeightDp" to 62.5, "theme" to "dark", "autocorrect" to false, "swipe" to false,
                "hapticStrength" to 4.0, "soundVolume" to 0.3, "language" to "he", "oneHanded" to -1.0,
                "clipboardExpiryMs" to 15.0 * 60_000, "screenLearning" to true,
            ),
        )
        val p = UiPrefs(ctx)
        assertEquals(62.5f, p.keyHeightDp, 0.001f)
        assertEquals("dark", p.theme)
        assertFalse(p.autocorrect)
        assertFalse(p.swipe)
        assertEquals(4, p.hapticStrength)
        assertEquals(0.3f, p.soundVolume, 0.001f)
        assertEquals("he", p.language)
        assertEquals(-1, p.oneHanded)
        assertEquals(15L * 60_000, p.clipboardExpiryMs)
        assertTrue(p.screenLearning)
        assertEquals("dark", out["theme"])
        assertEquals(false, out["autocorrect"])
        assertEquals(KeyboardBridge.PREFERENCE_KEYS.toSet(), out.keys)
    }

    @Test fun ignoresUnknownKeysWrongTypesAndOutOfRangeValues() {
        val before = KeyboardBridge.preferences(ctx)
        KeyboardBridge.setPreferences(
            ctx,
            mapOf("theme" to "purple", "autocorrect" to "no", "nope" to 1, "clipboardExpiryMs" to 12345.0, "language" to "fr", "keyHeightDp" to Double.NaN),
        )
        assertEquals(before, KeyboardBridge.preferences(ctx))
        KeyboardBridge.setPreferences(ctx, mapOf("keyHeightDp" to 500.0, "hapticStrength" to 99.0, "soundVolume" to 7.0, "oneHanded" to 3.0))
        val p = UiPrefs(ctx)
        assertEquals(UiPrefs.MAX_KEY_HEIGHT, p.keyHeightDp, 0.001f)
        assertEquals(5, p.hapticStrength)
        assertEquals(1f, p.soundVolume, 0.001f)
        assertEquals(1, p.oneHanded)
    }

    @Test fun excludedAppsAreValidatedAndResettable() {
        val saved = KeyboardBridge.setExcludedApps(ctx, listOf("com.my.bank", "not a package", "com.my.bank", "org.other.app"))
        assertEquals(listOf("com.my.bank", "org.other.app"), saved)
        assertEquals(saved, KeyboardBridge.excludedApps(ctx))
        assertEquals(ScreenPolicy.DEFAULT_EXCLUDED, KeyboardBridge.setExcludedApps(ctx, null))
        assertTrue("dev.talorys.app" in ScreenPolicy.DEFAULT_EXCLUDED)
    }

    @Test fun constantsComeFromTheKeyboard() {
        val c = KeyboardBridge.constants()
        assertEquals(UiPrefs.KEY_HEIGHT_PRESETS.map { it.toDouble() }, c["keyHeightPresets"])
        assertEquals(4, (c["clipboardExpiryChoices"] as List<*>).size)
    }

    @Test fun oneLoginTheAppSessionBecomesTheKeyboards() {
        assertEquals("https://x.pages.dev/api", AgentClient.agentApiUrl("https://x.pages.dev/"))
        assertEquals("https://x.pages.dev/api", AgentClient.agentApiUrl("https://x.pages.dev/api"))
        assertEquals("", AgentClient.agentApiUrl("  "))

        val client = AgentClient.get(ctx)
        client.setSession("https://talorys-lxl5w9o0-web.pages.dev", "tok-123")
        assertTrue(client.isConfigured)
        assertEquals("https://talorys-lxl5w9o0-web.pages.dev/api", client.agentUrl)
        assertEquals("tok-123", client.sessionToken)
        assertEquals(true, KeyboardBridge.status(ctx)["signedIn"])

        // Sign-out / 401: the token goes, the keyboard is no longer configured.
        client.setSession("https://talorys-lxl5w9o0-web.pages.dev", null)
        assertFalse(client.isConfigured)
        assertEquals(false, KeyboardBridge.dictionaryStatus(ctx)["signedIn"])
    }
}
