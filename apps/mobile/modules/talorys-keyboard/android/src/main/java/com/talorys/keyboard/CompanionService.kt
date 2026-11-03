package com.talorys.keyboard

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.min

private const val TAG = "TalorysCompanion"
private const val CHANNEL_ID = "talorys_companion"
private const val NOTIFICATION_ID = 1001
private const val POLL_VISIBLE_MS = 60_000L
private const val POLL_BACKGROUND_MS = 5 * 60_000L
private const val BACKOFF_BASE_MS = 30_000L
private const val BACKOFF_MAX_MS = 15 * 60_000L

/**
 * Polls the Talorys agent for suggestions and publishes them as a [StateFlow].
 *
 * Normally a plain bound service: the keyboard binds it while it's the active IME (the system keeps
 * the IME alive), and polling runs every minute while the keyboard is on screen. When the user turns
 * on "Keep agent connected in background" the Settings screen (a foreground activity, so the start is
 * allowed on Android 12+) starts it as a dataSync foreground service. Every foreground transition is
 * guarded so a refused start never crashes the keyboard.
 *
 * Failures back off exponentially (30 s → 15 min); a successful poll resets the backoff.
 */
class CompanionService : Service() {

    inner class LocalBinder : Binder() {
        val service: CompanionService get() = this@CompanionService
    }

    private val binder = LocalBinder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val wake = Channel<Boolean>(Channel.CONFLATED) // value = force (ignore backoff)

    lateinit var client: AgentClient
        private set

    private val _suggestions = MutableStateFlow<List<Suggestion>>(emptyList())
    val suggestions: StateFlow<List<Suggestion>> = _suggestions.asStateFlow()

    @Volatile private var keyboardVisible = false
    @Volatile private var inForeground = false
    @Volatile private var failures = 0
    @Volatile private var nextAllowedAt = 0L

    override fun onCreate() {
        super.onCreate()
        client = AgentClient.get(this)
        scope.launch { pollLoop() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP_FOREGROUND -> {
                leaveForeground()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START_FOREGROUND -> {
                // Must call startForeground() promptly after startForegroundService(), even if the
                // user switched the option off meanwhile; then drop straight back out.
                enterForeground()
                if (!UiPrefs(this).alwaysOn) { leaveForeground(); stopSelf(startId) }
            }
            else -> {
                // Sticky restart (null intent) after the process was killed.
                if (UiPrefs(this).alwaysOn) enterForeground() else stopSelf(startId)
            }
        }
        return if (inForeground) START_STICKY else START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    /** Android 15+: dataSync foreground services get a daily time budget; give it back when told. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.i(TAG, "Foreground time limit reached; continuing as a bound service only")
        leaveForeground()
        stopSelf(startId)
    }

    // ---- public API for bound clients ----

    fun setKeyboardVisible(visible: Boolean) {
        keyboardVisible = visible
        if (visible) wake.trySend(false)
    }

    /** Poll now. [force] skips the failure backoff (e.g. right after the user saved new settings). */
    fun refreshNow(force: Boolean = false) {
        if (force) { failures = 0; nextAllowedAt = 0 }
        wake.trySend(force)
    }

    /** Tap on a suggestion: it was used. */
    fun accept(id: String) = updateStatus(id, "accepted")

    /** Long-press on a suggestion: hide it. */
    fun dismiss(id: String) = updateStatus(id, "dismissed")

    private fun updateStatus(id: String, status: String) {
        _suggestions.value = _suggestions.value.filter { it.id != id }
        scope.launch { client.setSuggestionStatus(id, status) }
    }

    // ---- polling ----

    private suspend fun pollLoop() {
        while (scope.isActive) {
            var waitMs: Long? = null
            val shouldPoll = client.isConfigured && (keyboardVisible || inForeground)
            if (shouldPoll && SystemClock.elapsedRealtime() >= nextAllowedAt) {
                val result = client.fetchSuggestions()
                if (result.isSuccess) {
                    failures = 0
                    _suggestions.value = result.getOrDefault(emptyList())
                    waitMs = if (keyboardVisible) POLL_VISIBLE_MS else POLL_BACKGROUND_MS
                } else {
                    failures++
                    waitMs = min(BACKOFF_BASE_MS shl min(failures - 1, 10), BACKOFF_MAX_MS)
                    Log.w(TAG, "Poll failed ($failures in a row), retrying in ${waitMs / 1000}s")
                }
                nextAllowedAt = SystemClock.elapsedRealtime() + waitMs
            } else if (shouldPoll) {
                waitMs = nextAllowedAt - SystemClock.elapsedRealtime()
            } else if (!client.isConfigured) {
                _suggestions.value = emptyList()
            }
            // Sleep until the next poll or until woken (keyboard shown / refreshNow).
            withTimeoutOrNull(waitMs ?: Long.MAX_VALUE) { wake.receive() }
        }
    }

    // ---- foreground mode ----

    private fun enterForeground() {
        if (inForeground) return
        try {
            createNotificationChannel()
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, buildNotification(),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
            )
            inForeground = true
            wake.trySend(false)
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+), missing type, or exhausted time budget.
            Log.w(TAG, "Could not enter foreground; staying a bound service", e)
            inForeground = false
        }
    }

    private fun leaveForeground() {
        if (!inForeground) return
        inForeground = false
        runCatching { ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE) }
    }

    private fun createNotificationChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.tk_notif_channel_name),
            NotificationManager.IMPORTANCE_MIN,
        ).apply {
            description = getString(R.string.tk_notif_channel_desc)
            setShowBadge(false)
        }
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val settingsIntent = PendingIntent.getActivity(
            this, 0,
            AppLink.intent(this, AppLink.KEYBOARD_SETTINGS),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.tk_notif_title))
            .setContentText(getString(R.string.tk_notif_text))
            .setSmallIcon(R.drawable.tk_ic_stat_talorys)
            .setContentIntent(settingsIntent)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .build()
    }

    companion object {
        const val ACTION_START_FOREGROUND = "com.talorys.keyboard.action.START_FOREGROUND"
        const val ACTION_STOP_FOREGROUND = "com.talorys.keyboard.action.STOP_FOREGROUND"

        /** Start always-on mode. Call only from a visible activity; never throws. */
        fun startForegroundMode(context: Context): Boolean = try {
            ContextCompat.startForegroundService(
                context, Intent(context, CompanionService::class.java).setAction(ACTION_START_FOREGROUND),
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "startForegroundService refused", e)
            false
        }

        fun stopForegroundMode(context: Context) {
            runCatching {
                context.startService(Intent(context, CompanionService::class.java).setAction(ACTION_STOP_FOREGROUND))
            }.onFailure { Log.w(TAG, "stop foreground failed", it) }
        }
    }
}
