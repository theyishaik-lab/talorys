package com.talorys.localllm

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.util.UUID

private const val TAG = "TalorysLocalLlm"

/** Non-secret settings of the local models (what the "Local models" screen writes). */
class LocalPrefs(context: Context) {
    private val prefs: SharedPreferences = context.applicationContext.getSharedPreferences("talorys_local_llm", Context.MODE_PRIVATE)

    fun useInChain(id: String): Boolean = prefs.getBoolean("chain_$id", false)
    fun setUseInChain(id: String, on: Boolean) = prefs.edit { putBoolean("chain_$id", on) }

    /** Download only on an unmetered network (Wi-Fi). Default on: the files are 1.8 and 3.7 GB. */
    var wifiOnly: Boolean
        get() = prefs.getBoolean("wifi_only", true)
        set(v) = prefs.edit { putBoolean("wifi_only", v) }

    /** Keep the device bridge open while the keyboard's companion service runs in the foreground. */
    var backgroundBridge: Boolean
        get() = prefs.getBoolean("background_bridge", false)
        set(v) = prefs.edit { putBoolean("background_bridge", v) }

    /** Answer locally in the app's chat when the agent is unreachable. */
    var offlineFallback: Boolean
        get() = prefs.getBoolean("offline_fallback", false)
        set(v) = prefs.edit { putBoolean("offline_fallback", v) }

    /** The model the offline fallback uses ("" = the first downloaded one). */
    var offlineModel: String
        get() = prefs.getString("offline_model", "") ?: ""
        set(v) = prefs.edit { putString("offline_model", v) }

    /** A random id per install, so the agent can tell phones apart. */
    val deviceId: String
        get() = prefs.getString("device_id", null) ?: UUID.randomUUID().toString().also { id -> prefs.edit { putString("device_id", id) } }

    fun anyInChain(): Boolean = ModelSpecs.ALL.any { useInChain(it.id) }
}

/**
 * The app's session (server origin + native bearer token), handed over from JS on every sign-in /
 * sign-out so the bridge can reconnect from the companion service without the JS runtime. The token
 * sits in EncryptedSharedPreferences (Android Keystore AES-256-GCM).
 */
class LocalSession private constructor(private val prefs: SharedPreferences) {
    var server: String
        get() = prefs.getString("server", "") ?: ""
        private set(v) = prefs.edit { putString("server", v) }

    var token: String
        get() = prefs.getString("token", "") ?: ""
        private set(v) = prefs.edit { putString("token", v) }

    val isSet: Boolean get() = server.isNotBlank() && token.isNotBlank()

    fun set(server: String?, token: String?) {
        prefs.edit {
            val s = server?.trim()?.trimEnd('/')?.removeSuffix("/api").orEmpty()
            if (s.isNotEmpty()) putString("server", s)
            if (token.isNullOrBlank()) remove("token") else putString("token", token.trim())
        }
    }

    companion object {
        private const val FILE = "talorys_local_llm_secure"
        @Volatile private var instance: LocalSession? = null

        fun get(context: Context): LocalSession = instance ?: synchronized(this) {
            instance ?: LocalSession(open(context.applicationContext)).also { instance = it }
        }

        @Suppress("DEPRECATION") // security-crypto 1.1.0 deprecates these APIs, no replacement yet
        private fun create(context: Context): SharedPreferences {
            val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            return EncryptedSharedPreferences.create(context, FILE, key, EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV, EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
        }

        private fun open(context: Context): SharedPreferences = try {
            create(context)
        } catch (first: Exception) {
            Log.w(TAG, "Encrypted prefs unreadable, resetting", first)
            runCatching { context.deleteSharedPreferences(FILE) }
            try {
                create(context)
            } catch (second: Exception) {
                Log.e(TAG, "Android Keystore unavailable; the bridge session stays in memory only", second)
                context.getSharedPreferences("talorys_local_llm_volatile", Context.MODE_PRIVATE).also { it.edit { clear() } }
            }
        }
    }
}

/** Where model files live: the app's external files dir (no storage permission), else internal storage. */
object ModelFiles {
    fun dir(context: Context): File {
        val base = context.getExternalFilesDir("models") ?: File(context.filesDir, "models")
        if (!base.exists()) base.mkdirs()
        return base
    }

    fun file(context: Context, spec: ModelSpec) = File(dir(context), spec.file)
    fun partial(context: Context, spec: ModelSpec) = File(dir(context), "${spec.file}.part")
    /** Written after the SHA-256 matched; a file without it is verified again before use. */
    fun verified(context: Context, spec: ModelSpec) = File(dir(context), "${spec.file}.verified")

    fun isDownloaded(context: Context, spec: ModelSpec): Boolean {
        val f = file(context, spec)
        return f.exists() && f.length() == spec.sizeBytes && verified(context, spec).exists()
    }

    fun delete(context: Context, spec: ModelSpec) {
        file(context, spec).delete()
        partial(context, spec).delete()
        verified(context, spec).delete()
    }
}
