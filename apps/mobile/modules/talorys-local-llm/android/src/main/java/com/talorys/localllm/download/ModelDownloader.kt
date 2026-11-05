package com.talorys.localllm.download

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.StatFs
import android.util.Log
import com.talorys.localllm.Logic
import com.talorys.localllm.ModelFiles
import com.talorys.localllm.ModelSpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

private const val TAG = "TalorysLocalLlm"

/** Progress of one download, as the Settings screen shows it. */
data class DownloadProgress(
    val id: String,
    val downloadedBytes: Long,
    val totalBytes: Long,
    /** "downloading" | "verifying" | "done" | "paused" | "error" */
    val phase: String,
    val error: String? = null,
)

/**
 * Downloads model files into the app's external files dir (no storage permission needed; removed
 * with the app). Resumable: bytes go to `<file>.part`, a restart asks for `Range: bytes=<n>-` and
 * keeps going only when the server answers 206 from exactly that offset. When complete, the size and
 * the SHA-256 are checked before the file is renamed into place (and marked verified). Optional
 * Wi-Fi-only: the download refuses to start, and pauses, on a metered network.
 */
class ModelDownloader(private val context: Context, private val onProgress: (DownloadProgress) -> Unit) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val jobs = ConcurrentHashMap<String, Job>()
    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    fun isActive(id: String): Boolean = jobs[id]?.isActive == true

    /** Bytes already on disk for a model that is not complete yet. */
    fun partialBytes(spec: ModelSpec): Long = ModelFiles.partial(context, spec).let { if (it.exists()) it.length() else 0L }

    fun start(spec: ModelSpec, wifiOnly: Boolean) {
        if (isActive(spec.id) || ModelFiles.isDownloaded(context, spec)) return
        jobs[spec.id] = scope.launch {
            try {
                run(spec, wifiOnly)
            } catch (e: CancellationException) {
                onProgress(DownloadProgress(spec.id, partialBytes(spec), spec.sizeBytes, "paused"))
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "download ${spec.id} failed", e)
                onProgress(DownloadProgress(spec.id, partialBytes(spec), spec.sizeBytes, "error", e.message ?: e.javaClass.simpleName))
            } finally {
                jobs.remove(spec.id)
            }
        }
    }

    /** Stops a download, keeping the partial file for a later resume. */
    fun pause(id: String) {
        jobs.remove(id)?.cancel()
    }

    private suspend fun run(spec: ModelSpec, wifiOnly: Boolean) {
        if (wifiOnly && isMetered()) throw IOException("Waiting for Wi-Fi (Wi-Fi only is on).")
        val part = ModelFiles.partial(context, spec)
        var offset = Logic.resumeOffset(if (part.exists()) part.length() else 0L, spec.sizeBytes)
        if (offset == 0L && part.exists()) part.delete()
        if (!Logic.hasSpace(freeBytes(part.parentFile ?: ModelFiles.dir(context)), spec.sizeBytes - offset)) {
            throw IOException("Not enough free storage: ${(spec.sizeBytes - offset) / (1024 * 1024)} MB more are needed (plus 200 MB).")
        }
        if (offset < spec.sizeBytes) {
            val req = Request.Builder().url(spec.url).apply { if (offset > 0) header("Range", "bytes=$offset-") }.build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) throw IOException("Download failed: HTTP ${resp.code}")
                if (!Logic.rangeHonoured(resp.code, resp.header("Content-Range"), offset)) {
                    // The server sent the whole file: start the partial over.
                    if (offset > 0) {
                        part.delete()
                        offset = 0
                        if (resp.code != 200) throw IOException("The server did not resume the download (HTTP ${resp.code}).")
                    }
                }
                val body = resp.body ?: throw IOException("Empty response")
                val throttle = Logic.Throttle(500)
                var done = offset
                FileOutputStream(part, offset > 0).use { out ->
                    body.byteStream().use { input ->
                        val buf = ByteArray(256 * 1024)
                        var sinceNetCheck = 0L
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            sinceNetCheck += n
                            if (wifiOnly && sinceNetCheck > 16L * 1024 * 1024) {
                                sinceNetCheck = 0
                                if (isMetered()) throw IOException("Paused: Wi-Fi was lost (Wi-Fi only is on).")
                            }
                            if (done > spec.sizeBytes) throw IOException("The file is larger than expected.")
                            if (throttle.ready(System.currentTimeMillis())) onProgress(DownloadProgress(spec.id, done, spec.sizeBytes, "downloading"))
                        }
                    }
                }
            }
        }
        val got = part.length()
        if (got != spec.sizeBytes) throw IOException("Incomplete download: $got of ${spec.sizeBytes} bytes. Tap Download to resume.")
        onProgress(DownloadProgress(spec.id, got, spec.sizeBytes, "verifying"))
        val sha = sha256(part)
        if (!sha.equals(spec.sha256, ignoreCase = true)) {
            part.delete()
            throw IOException("Checksum mismatch; the file was discarded. Please download again.")
        }
        val target = ModelFiles.file(context, spec)
        target.delete()
        if (!part.renameTo(target)) throw IOException("Could not move the model into place.")
        ModelFiles.verified(context, spec).writeText(sha)
        onProgress(DownloadProgress(spec.id, spec.sizeBytes, spec.sizeBytes, "done"))
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buf = ByteArray(1024 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return Logic.hex(md.digest())
    }

    private fun isMetered(): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return true
        return !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    private fun freeBytes(dir: File): Long = runCatching { StatFs(dir.path).availableBytes }.getOrDefault(Long.MAX_VALUE)
}
