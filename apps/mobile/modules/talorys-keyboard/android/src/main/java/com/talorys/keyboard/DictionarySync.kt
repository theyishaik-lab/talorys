package com.talorys.keyboard

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.talorys.keyboard.suggest.DictionaryPayload
import com.talorys.keyboard.suggest.UserDictionary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

private const val TAG = "TalorysDictSync"

/** The personal dictionary, shared by the keyboard, settings and the backup worker (one per process). */
object LearnedWords {
    @Volatile private var instance: UserDictionary? = null

    fun get(context: Context): UserDictionary = instance ?: synchronized(this) {
        instance ?: UserDictionary(File(context.applicationContext.noBackupFilesDir, "learned_words.json")).also { instance = it }
    }
}

/**
 * Optional backup of the personal dictionary to the user's own Talorys agent
 * (GET/PUT {agent}/api/keyboard/dictionary). Merge rules live in [com.talorys.keyboard.suggest.DictionaryMerge].
 * Runs only when the agent is configured and "Backup to Talorys cloud" is on, at most every
 * 15 minutes when the keyboard hides, or on "Sync now".
 */
object DictionarySync {
    private const val WORK = "talorys-dictionary-sync"
    const val MIN_INTERVAL_MS = 15 * 60 * 1000L

    fun enabled(context: Context): Boolean = UiPrefs(context).cloudBackup && AgentClient.get(context).isConfigured

    /** Called when the keyboard hides: syncs if something changed and the last attempt is 15+ min old. */
    fun maybeSchedule(context: Context) {
        if (!enabled(context)) return
        val prefs = UiPrefs(context)
        val store = LearnedWords.get(context)
        if (!store.unsynced && prefs.lastDictSync != 0L) return
        val now = System.currentTimeMillis()
        if (now - prefs.lastDictSyncAttempt < MIN_INTERVAL_MS) return
        prefs.lastDictSyncAttempt = now
        enqueue(context, ExistingWorkPolicy.KEEP)
    }

    /** "Sync now" in settings, and after "Clear learned words". */
    fun syncNow(context: Context) {
        if (!enabled(context)) return
        UiPrefs(context).lastDictSyncAttempt = System.currentTimeMillis()
        enqueue(context, ExistingWorkPolicy.REPLACE)
    }

    private fun enqueue(context: Context, policy: ExistingWorkPolicy) {
        runCatching {
            val req = OneTimeWorkRequestBuilder<DictionarySyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(WORK, policy, req)
        }.onFailure { Log.w(TAG, "enqueue failed", it) }
    }

    /**
     * Restore: download the backup and merge it into this phone's dictionary, without uploading
     * (works with the backup switch off). Used after moving from the separate keyboard app.
     * Returns the number of learned words afterwards.
     */
    suspend fun restore(context: Context): Int = withContext(Dispatchers.IO) {
        val client = AgentClient.get(context)
        if (!client.isConfigured) throw AgentException("not signed in")
        val store = LearnedWords.get(context)
        val remote = DictionaryPayload.fromJson(client.getDictionary())
        if (remote != null && remote.schema > 1) throw AgentException("dictionary schema ${remote.schema} is newer than this app")
        store.mergeRemote(remote)
        remote?.screenWords?.let { words ->
            val screen = com.talorys.keyboard.screen.ScreenWordLearner.store(context)
            screen.mergeBackup(words)
            screen.flush()
        }
        store.flush()
        store.learnedWordCount()
    }

    /** One sync round: download, merge, upload. Returns true on success. */
    suspend fun runOnce(context: Context): Boolean = withContext(Dispatchers.IO) {
        if (!enabled(context)) return@withContext true
        val client = AgentClient.get(context)
        val store = LearnedWords.get(context)
        val remoteText = client.getDictionary()
        val remote = DictionaryPayload.fromJson(remoteText)
        if (remote != null && remote.schema > 1) throw AgentException("dictionary schema ${remote.schema} is newer than this app")
        val merged = store.mergeRemote(remote)
        // Screen-learned words go up only with their own opt-in, separate from the typed-word backup.
        val upload = if (UiPrefs(context).screenBackup) {
            val screen = com.talorys.keyboard.screen.ScreenWordLearner.store(context)
            screen.mergeBackup(remote?.screenWords)
            screen.flush()
            merged.copy(screenWords = screen.exportForBackup())
        } else merged
        client.putDictionary(upload.toJson())
        store.markSynced(merged.updatedAt)
        store.flush()
        UiPrefs(context).lastDictSync = System.currentTimeMillis()
        true
    }
}

class DictionarySyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = try {
        DictionarySync.runOnce(applicationContext)
        Result.success()
    } catch (e: AgentException) {
        Log.w(TAG, "sync failed: ${e.message}")
        // Auth / client errors won't fix themselves; network and server errors are retried.
        if (e.httpCode in 400..499) Result.failure() else if (runAttemptCount < 3) Result.retry() else Result.failure()
    } catch (e: Exception) {
        Log.w(TAG, "sync failed", e)
        if (runAttemptCount < 3) Result.retry() else Result.failure()
    }
}
