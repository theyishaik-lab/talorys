package com.talorys.keyboard.clip

import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.io.File
import java.security.KeyStore
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val TAG = "TalorysClip"

/**
 * The keyboard's clipboard history. Listens for copies while the keyboard service runs (Android
 * lets only the active keyboard read the clipboard in the background), skips sensitive clips,
 * and keeps the history in app-private storage, encrypted with an Android Keystore AES-GCM key.
 * If the Keystore is unavailable the history is kept in memory only (never written in clear).
 */
class ClipboardHistory private constructor(context: Context) {

    private val app = context.applicationContext
    private val file = File(app.noBackupFilesDir, "clipboard.bin")
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "talorys-clip-io").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    val store = ClipboardStore()

    /** Called on the main thread after a new clip was stored. */
    var onNewClip: ((ClipItem) -> Unit)? = null

    /** Is the current field a password field (clips copied from it are skipped)? */
    var passwordFieldFocused: () -> Boolean = { false }

    var enabled: Boolean = true
    private var listening: ClipboardManager? = null
    private val listener = ClipboardManager.OnPrimaryClipChangedListener { capture(fromListener = true) }

    init {
        io.execute {
            val json = runCatching { if (file.exists()) Crypto.decrypt(file.readBytes()) else null }
                .onFailure { Log.w(TAG, "clipboard history unreadable; starting empty", it) }.getOrNull()
            store.load(json)
        }
    }

    fun configure(enabled: Boolean, expiryMs: Long) {
        this.enabled = enabled
        store.expiryMs = expiryMs
        if (!enabled) { store.clear(includePinned = false); persist() }
    }

    fun startListening() {
        if (listening != null) return
        val cm = app.getSystemService(ClipboardManager::class.java) ?: return
        runCatching { cm.addPrimaryClipChangedListener(listener); listening = cm }
            .onFailure { Log.w(TAG, "clipboard listener refused", it) }
    }

    fun stopListening() {
        listening?.let { runCatching { it.removePrimaryClipChangedListener(listener) } }
        listening = null
    }

    /**
     * Reads the current primary clip into the history (e.g. when the clipboard panel opens).
     * Returns the stored item, or null.
     */
    fun capture(fromListener: Boolean = false): ClipItem? {
        if (!enabled) return null
        val cm = app.getSystemService(ClipboardManager::class.java) ?: return null
        val clip = runCatching { cm.primaryClip }.getOrNull() ?: return null
        val desc = clip.description
        if (ClipPolicy.skip(isSensitive(desc), passwordFieldFocused(), desc?.label)) return null
        if (clip.itemCount == 0) return null
        val text = runCatching { clip.getItemAt(0).coerceToText(app) }.getOrNull() ?: return null
        val before = store.latest()
        val item = store.add(text) ?: return null
        val isNew = before == null || before.text != item.text || fromListener
        persist()
        if (isNew && fromListener) main.post { onNewClip?.invoke(item) }
        return item
    }

    /** Saves in the background (after the initial load, which runs first on the same thread). */
    fun persist() {
        io.execute { persistNow() }
    }

    private fun persistNow() {
        val json = store.save()
        runCatching {
            val bytes = Crypto.encrypt(json) ?: run { file.delete(); return }
            val tmp = File(file.parentFile, file.name + ".tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
        }.onFailure { Log.w(TAG, "clipboard history not saved", it) }
    }

    private fun isSensitive(desc: ClipDescription?): Boolean {
        val extras = desc?.extras ?: return false
        val key = if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
        return extras.getBoolean(key, false)
    }

    /** AES-256-GCM with a non-exportable Android Keystore key. */
    private object Crypto {
        private const val ALIAS = "talorys_clipboard_v1"
        private const val MAGIC = "TCB1:"

        private fun key(): SecretKey? = runCatching {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(256)
                        .build(),
                )
                generateKey()
            }
        }.onFailure { Log.w(TAG, "keystore unavailable; clipboard history stays in memory", it) }.getOrNull()

        fun encrypt(plain: String): ByteArray? {
            val k = key() ?: return null
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, k)
            val iv = c.iv
            val body = c.doFinal(plain.toByteArray(Charsets.UTF_8))
            val out = MAGIC + Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(body, Base64.NO_WRAP)
            return out.toByteArray(Charsets.US_ASCII)
        }

        fun decrypt(bytes: ByteArray): String? {
            val s = String(bytes, Charsets.US_ASCII)
            if (!s.startsWith(MAGIC)) return null
            val parts = s.removePrefix(MAGIC).split(':')
            if (parts.size != 2) return null
            val k = key() ?: return null
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            return String(c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        }
    }

    companion object {
        // Holds only the application context (no Activity / Service), so no leak.
        @android.annotation.SuppressLint("StaticFieldLeak")
        @Volatile private var instance: ClipboardHistory? = null
        fun get(context: Context): ClipboardHistory = instance ?: synchronized(this) {
            instance ?: ClipboardHistory(context).also { instance = it }
        }
    }
}
