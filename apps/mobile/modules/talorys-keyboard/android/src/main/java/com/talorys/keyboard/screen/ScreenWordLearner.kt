package com.talorys.keyboard.screen

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import com.talorys.keyboard.UiPrefs
import java.io.File

private const val TAG = "TalorysScreenWords"

/**
 * Glue between the accessibility service and [ScreenWordStore]: debounces window events, reads the
 * visible text on a background thread with hard caps, and never reads password fields, editable
 * fields (what the user types is learned by the keyboard itself), or excluded apps.
 * Everything stays on the device in app-private no-backup storage.
 */
object ScreenWordLearner {
    /** Quiet time after the last event of a window before it is read. */
    const val DEBOUNCE_MS = 1_500L
    /** At most one read per this interval, whatever the event rate. */
    const val MIN_INTERVAL_MS = 4_000L
    /** Caps per read: characters of text and nodes visited. */
    const val MAX_CHARS = 4_000
    const val MAX_NODES = 400
    private const val MAX_DEPTH = 40
    private const val MAX_NODE_TEXT = 500

    @Volatile private var store: ScreenWordStore? = null
    private val thread by lazy { HandlerThread("talorys-screen-words").apply { start() } }
    private val handler by lazy { Handler(thread.looper) }
    @Volatile private var lastRun = 0L

    fun store(context: Context): ScreenWordStore = store ?: synchronized(this) {
        store ?: ScreenWordStore(File(context.applicationContext.noBackupFilesDir, "screen_words.json")).also { store = it }
    }

    /** Changes whenever screen words change (cache key for suggestions). */
    fun version(): Long = store?.version ?: 0L

    fun enabled(context: Context): Boolean = UiPrefs(context).screenLearning

    @Volatile private var excludedCache: Pair<Long, List<String>>? = null
    /** Re-parsed at most every few seconds (events can arrive many times a second). */
    private fun excluded(prefs: UiPrefs): List<String> {
        val now = SystemClock.uptimeMillis()
        excludedCache?.let { (at, list) -> if (now - at < 3_000) return list }
        return prefs.screenExcluded.also { excludedCache = now to it }
    }

    /** Settings changed the exclusion list. */
    fun invalidateExcluded() { excludedCache = null }

    /**
     * Called by the accessibility service for content events. [readRoot] returns the active window's
     * root node; it is called later, on the background thread, only if the app is not excluded.
     */
    fun onWindowEvent(context: Context, pkg: String?, readRoot: () -> AccessibilityNodeInfo?) {
        val prefs = UiPrefs(context)
        if (!prefs.screenLearning) return
        if (ScreenPolicy.isExcluded(pkg, excluded(prefs))) return
        handler.removeCallbacksAndMessages(null)
        val wait = maxOf(DEBOUNCE_MS, lastRun + MIN_INTERVAL_MS - SystemClock.uptimeMillis())
        handler.postDelayed({ runCatching { process(context, pkg!!, readRoot) }.onFailure { Log.w(TAG, "read failed", it) } }, wait)
    }

    private fun process(context: Context, pkg: String, readRoot: () -> AccessibilityNodeInfo?) {
        if (!enabled(context)) return
        lastRun = SystemClock.uptimeMillis()
        val root = readRoot() ?: return
        if (root.packageName?.toString() != pkg) return
        val collected = StringBuilder()
        val ok = collect(root, collected)
        if (!ok || collected.isEmpty()) return
        val text = collected.toString()
        val tokens = ScreenTokenizer.tokenize(text)
        if (tokens.isEmpty()) return
        // Same app + same visible text = same screen: a re-render or a re-read never counts twice.
        val key = (pkg.hashCode().toLong() shl 32) xor text.hashCode().toLong()
        val s = store(context)
        s.recordEvent(key, tokens)
        s.flush()
    }

    /**
     * Gathers visible, non-editable text. Returns false when the window shows a password field: then
     * nothing from that window is used at all.
     */
    @Suppress("DEPRECATION")
    private fun collect(root: AccessibilityNodeInfo, out: StringBuilder): Boolean {
        val stack = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        stack.addLast(root to 0)
        var visited = 0
        var sensitive = false
        while (stack.isNotEmpty()) {
            val (node, depth) = stack.removeLast()
            try {
                visited++
                if (node.isPassword) { sensitive = true; break }
                if (visited > MAX_NODES || out.length >= MAX_CHARS) continue
                if (!node.isVisibleToUser) continue
                if (!node.isEditable) {
                    node.text?.let { t -> if (t.isNotBlank()) out.append(t, 0, minOf(t.length, MAX_NODE_TEXT)).append('\n') }
                }
                if (depth < MAX_DEPTH) for (i in 0 until node.childCount) node.getChild(i)?.let { stack.addLast(it to depth + 1) }
            } catch (e: RuntimeException) {
                // A node can go stale while we read; skip it.
            } finally {
                if (node !== root) node.recycle()
            }
        }
        // Recycle whatever was left after an early stop.
        for ((n, _) in stack) if (n !== root) runCatching { n.recycle() }
        if (out.length > MAX_CHARS) out.setLength(MAX_CHARS)
        return !sensitive
    }

    /** The user typed or accepted [word]: an eligible screen word moves to the personal dictionary. */
    fun onUserTyped(context: Context, lang: String, word: String): Boolean {
        val s = store ?: if (File(context.applicationContext.noBackupFilesDir, "screen_words.json").exists()) store(context) else return false
        return s.promote(lang, word)
    }
}
