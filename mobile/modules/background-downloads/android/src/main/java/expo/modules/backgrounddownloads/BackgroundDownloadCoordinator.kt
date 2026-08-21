package expo.modules.backgrounddownloads

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.workDataOf
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.util.concurrent.TimeUnit

internal data class BackgroundDownloadJob(
  var key: String,
  var transferToken: String,
  var accountScope: String,
  var songId: String,
  var scopes: List<String>,
  var songJSON: String,
  var audioURL: String,
  var coverURL: String?,
  var lyricsURL: String?,
  var refreshURL: String,
  var requestedAudioPath: String,
  var requestedCoverPath: String?,
  var requestedLyricsPath: String?,
  var audioPath: String?,
  var coverPath: String?,
  var lyricsPath: String?,
  var status: String,
  var progress: Double,
  var bytesWritten: Long,
  var bytesExpected: Long,
  var error: String?,
  var refreshAttempts: Int,
  var pendingStage: String?,
  var priority: Double,
  var revision: Long,
  var updatedAt: Long,
)

class BackgroundDownloadCoordinator private constructor(
  private val context: Context,
) {
  var listener: ((Map<String, Any?>) -> Unit)? = null

  private val jobs = linkedMapOf<String, BackgroundDownloadJob>()
  private var activeAccount = "anonymous"
  private val lock = Any()

  fun restoreAndSchedule() {
    synchronized(lock) {
      loadLedgerLocked()
      ensureNotificationChannelLocked()
      scheduleActiveJobsLocked()
    }
  }

  fun enqueue(records: List<BackgroundDownloadRequestRecord>) {
    synchronized(lock) {
      if (records.isEmpty()) {
        scheduleActiveJobsLocked()
        return
      }
      for (record in records) {
        require(record.key.isNotEmpty() && record.transferToken.isNotEmpty()) { "invalid request" }
        require(record.accountScope.isNotEmpty() && record.songId.isNotEmpty()) { "invalid request" }
        require(isValidNetworkUrl(record.audioURL) && isValidNetworkUrl(record.refreshURL)) { "invalid request" }
        record.coverURL?.let { require(isValidNetworkUrl(it)) { "invalid request" } }
        record.lyricsURL?.let { require(isValidNetworkUrl(it)) { "invalid request" } }
        destinationFile(record.audioPath)
        record.coverPath?.let { destinationFile(it) }
        record.lyricsPath?.let { destinationFile(it) }
      }

      val now = nowMilliseconds()
      for (record in records) {
        val existing = jobs[record.key]
        if (existing != null && existing.transferToken == record.transferToken) {
          existing.accountScope = record.accountScope
          existing.songId = record.songId
          existing.scopes = record.scopes.toList()
          existing.songJSON = record.songJSON
          existing.audioURL = record.audioURL
          existing.coverURL = record.coverURL
          existing.lyricsURL = record.lyricsURL
          existing.refreshURL = record.refreshURL
          existing.requestedAudioPath = record.audioPath
          existing.requestedCoverPath = record.coverPath
          existing.requestedLyricsPath = record.lyricsPath
          existing.priority = record.priority
          existing.updatedAt = now
          continue
        }
        if (existing != null && existing.transferToken != record.transferToken) {
          cancelWork(record.key)
        }
        jobs[record.key] = BackgroundDownloadJob(
          key = record.key,
          transferToken = record.transferToken,
          accountScope = record.accountScope,
          songId = record.songId,
          scopes = record.scopes.toList(),
          songJSON = record.songJSON,
          audioURL = record.audioURL,
          coverURL = record.coverURL,
          lyricsURL = record.lyricsURL,
          refreshURL = record.refreshURL,
          requestedAudioPath = record.audioPath,
          requestedCoverPath = record.coverPath,
          requestedLyricsPath = record.lyricsPath,
          audioPath = null,
          coverPath = null,
          lyricsPath = null,
          status = "queued",
          progress = 0.0,
          bytesWritten = 0,
          bytesExpected = 0,
          error = null,
          refreshAttempts = 0,
          pendingStage = null,
          priority = record.priority,
          revision = 1,
          updatedAt = now,
        )
      }
      persistLedgerLocked()
      scheduleActiveJobsLocked()
    }
  }

  fun cancel(records: List<BackgroundDownloadReferenceRecord>) {
    synchronized(lock) {
      val removed = mutableListOf<String>()
      for (record in records) {
        val job = jobs[record.key] ?: continue
        if (job.transferToken != record.transferToken) continue
        cancelWork(job.key)
        jobs.remove(job.key)
        removed.add(job.key)
      }
      if (removed.isNotEmpty()) persistLedgerLocked()
    }
  }

  fun cancelAccount(accountScope: String) {
    synchronized(lock) {
      val keys = jobs.values.filter { it.accountScope == accountScope }.map { it.key }
      for (key in keys) {
        cancelWork(key)
        jobs.remove(key)
      }
      if (keys.isNotEmpty()) persistLedgerLocked()
    }
  }

  fun cancelAll() {
    synchronized(lock) {
      for (key in jobs.keys.toList()) cancelWork(key)
      jobs.clear()
      persistLedgerLocked()
    }
  }

  fun snapshot(accountScope: String?): List<Map<String, Any?>> {
    synchronized(lock) {
      return jobs.values
        .filter { accountScope == null || it.accountScope == accountScope }
        .sortedWith(compareBy({ it.updatedAt }, { it.key }))
        .map { snapshotMap(it) }
    }
  }

  fun acknowledge(records: List<BackgroundDownloadAcknowledgementRecord>) {
    synchronized(lock) {
      val removed = mutableListOf<String>()
      for (record in records) {
        val job = jobs[record.key] ?: continue
        if (
          job.transferToken == record.transferToken &&
          job.revision == record.revision &&
          (job.status == "ready" || job.status == "error")
        ) {
          jobs.remove(job.key)
          removed.add(job.key)
        }
      }
      if (removed.isNotEmpty()) persistLedgerLocked()
    }
  }

  fun setActiveAccount(accountScope: String) {
    synchronized(lock) {
      activeAccount = accountScope.ifEmpty { "anonymous" }
      persistLedgerLocked()
      for (job in jobs.values) {
        if (job.accountScope != activeAccount && (job.status == "queued" || job.status == "downloading")) {
          cancelWork(job.key)
          if (job.status == "downloading") {
            job.status = "queued"
            job.revision += 1
            job.updatedAt = nowMilliseconds()
            notifyLocked(job)
          }
        }
      }
      persistLedgerLocked()
      scheduleActiveJobsLocked()
    }
  }

  internal fun jobSnapshot(key: String, transferToken: String): BackgroundDownloadJob? {
    synchronized(lock) {
      val job = jobs[key] ?: return null
      if (job.transferToken != transferToken) return null
      return job.copy()
    }
  }

  internal fun markProgress(key: String, transferToken: String, written: Long, expected: Long) {
    synchronized(lock) {
      val job = jobs[key] ?: return
      if (job.transferToken != transferToken || job.status == "ready" || job.status == "error") return
      job.status = "downloading"
      job.bytesWritten = written
      job.bytesExpected = expected
      job.progress = if (expected > 0) (written.toDouble() / expected.toDouble()).coerceIn(0.0, 1.0) else 0.0
      job.updatedAt = nowMilliseconds()
      notifyLocked(job)
    }
  }

  internal fun markReady(key: String, transferToken: String, audioPath: String, coverPath: String?, lyricsPath: String?) {
    synchronized(lock) {
      val job = jobs[key] ?: return
      if (job.transferToken != transferToken) return
      job.status = "ready"
      job.progress = 1.0
      job.audioPath = audioPath
      job.coverPath = coverPath
      job.lyricsPath = lyricsPath
      job.error = null
      job.pendingStage = null
      job.revision += 1
      job.updatedAt = nowMilliseconds()
      persistLedgerLocked()
      notifyLocked(job)
    }
  }

  internal fun markError(key: String, transferToken: String, message: String) {
    synchronized(lock) {
      val job = jobs[key] ?: return
      if (job.transferToken != transferToken || job.status == "ready") return
      job.status = "error"
      job.error = message
      job.pendingStage = null
      job.revision += 1
      job.updatedAt = nowMilliseconds()
      persistLedgerLocked()
      notifyLocked(job)
    }
  }

  internal fun applyRefresh(key: String, transferToken: String, audioURL: String, coverURL: String?, lyricsURL: String?, songJSON: String) {
    synchronized(lock) {
      val job = jobs[key] ?: return
      if (job.transferToken != transferToken) return
      job.audioURL = audioURL
      job.coverURL = coverURL
      job.lyricsURL = lyricsURL
      job.songJSON = songJSON
      job.refreshAttempts += 1
      job.pendingStage = null
      job.status = "queued"
      job.error = null
      job.revision += 1
      job.updatedAt = nowMilliseconds()
      persistLedgerLocked()
      notifyLocked(job)
    }
  }

  internal fun destinationFile(relativePath: String): File {
    require(
      relativePath.startsWith("offline-media/") &&
        !relativePath.startsWith("/") &&
        !relativePath.split("/").contains(".."),
    ) { "invalid destination" }
    val root = context.filesDir.canonicalFile
    val destination = File(root, relativePath).canonicalFile
    require(destination.path.startsWith(root.path + File.separator)) { "invalid destination" }
    return destination
  }

  private fun scheduleActiveJobsLocked() {
    val ordered = jobs.values
      .filter {
        it.accountScope == activeAccount && it.status != "ready" && it.status != "error"
      }
      .sortedWith(compareByDescending<BackgroundDownloadJob> { it.priority }.thenBy { it.updatedAt }.thenBy { it.key })
    for (job in ordered) {
      val request = OneTimeWorkRequestBuilder<BackgroundDownloadWorker>()
        .setInputData(
          workDataOf(
            BackgroundDownloadWorker.KEY to job.key,
            BackgroundDownloadWorker.TOKEN to job.transferToken,
          ),
        )
        .setConstraints(
          Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
        )
        .apply {
          if (job.priority >= 0.8) {
            setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
          }
        }
        .build()
      WorkManager.getInstance(context).enqueueUniqueWork(
        uniqueWorkName(job.key),
        if (job.status == "downloading") ExistingWorkPolicy.KEEP else ExistingWorkPolicy.REPLACE,
        request,
      )
    }
  }

  private fun cancelWork(key: String) {
    WorkManager.getInstance(context).cancelUniqueWork(uniqueWorkName(key))
  }

  private fun uniqueWorkName(key: String): String = "$UNIQUE_WORK_PREFIX$key"

  private fun snapshotMap(job: BackgroundDownloadJob): Map<String, Any?> {
    val payload = mutableMapOf<String, Any?>(
      "key" to job.key,
      "transferToken" to job.transferToken,
      "accountScope" to job.accountScope,
      "songId" to job.songId,
      "scopes" to job.scopes,
      "songJSON" to job.songJSON,
      "status" to job.status,
      "progress" to job.progress,
      "bytesWritten" to job.bytesWritten.toDouble(),
      "bytesExpected" to job.bytesExpected.toDouble(),
      "revision" to job.revision.toDouble(),
      "updatedAt" to job.updatedAt.toDouble(),
    )
    job.audioPath?.let { payload["audioPath"] = it }
    job.coverPath?.let { payload["coverPath"] = it }
    job.lyricsPath?.let { payload["lyricsPath"] = it }
    job.error?.let { payload["error"] = it }
    return payload
  }

  private fun notifyLocked(job: BackgroundDownloadJob) {
    listener?.invoke(snapshotMap(job))
  }

  private fun ledgerFile(): File {
    val directory = File(context.filesDir, "BackgroundDownloads")
    directory.mkdirs()
    return File(directory, "ledger-v1.json")
  }

  private fun loadLedgerLocked() {
    val file = ledgerFile()
    if (!file.exists()) return
    try {
      val root = JSONObject(file.readText())
      if (root.optInt("version") != 1) return
      activeAccount = root.optString("activeAccount", "anonymous")
      val jobsObject = root.optJSONObject("jobs") ?: return
      val keys = jobsObject.keys()
      while (keys.hasNext()) {
        val key = keys.next()
        val item = jobsObject.optJSONObject(key) ?: continue
        jobs[key] = jobFromJson(item)
      }
    } catch (_: Exception) {
      // Keep an empty in-memory ledger rather than crashing restore.
    }
  }

  private fun persistLedgerLocked() {
    val root = JSONObject()
    root.put("version", 1)
    root.put("activeAccount", activeAccount)
    val jobsObject = JSONObject()
    for ((key, job) in jobs) {
      jobsObject.put(key, jobToJson(job))
    }
    root.put("jobs", jobsObject)
    val file = ledgerFile()
    val tmp = File(file.parentFile, "ledger-v1.json.tmp")
    tmp.writeText(root.toString())
    if (!tmp.renameTo(file)) {
      tmp.copyTo(file, overwrite = true)
      tmp.delete()
    }
  }

  private fun jobToJson(job: BackgroundDownloadJob): JSONObject {
    return JSONObject().apply {
      put("key", job.key)
      put("transferToken", job.transferToken)
      put("accountScope", job.accountScope)
      put("songId", job.songId)
      put("scopes", JSONArray(job.scopes))
      put("songJSON", job.songJSON)
      put("audioURL", job.audioURL)
      put("coverURL", job.coverURL ?: JSONObject.NULL)
      put("lyricsURL", job.lyricsURL ?: JSONObject.NULL)
      put("refreshURL", job.refreshURL)
      put("requestedAudioPath", job.requestedAudioPath)
      put("requestedCoverPath", job.requestedCoverPath ?: JSONObject.NULL)
      put("requestedLyricsPath", job.requestedLyricsPath ?: JSONObject.NULL)
      put("audioPath", job.audioPath ?: JSONObject.NULL)
      put("coverPath", job.coverPath ?: JSONObject.NULL)
      put("lyricsPath", job.lyricsPath ?: JSONObject.NULL)
      put("status", job.status)
      put("progress", job.progress)
      put("bytesWritten", job.bytesWritten)
      put("bytesExpected", job.bytesExpected)
      put("error", job.error ?: JSONObject.NULL)
      put("refreshAttempts", job.refreshAttempts)
      put("pendingStage", job.pendingStage ?: JSONObject.NULL)
      put("priority", job.priority)
      put("revision", job.revision)
      put("updatedAt", job.updatedAt)
    }
  }

  private fun jobFromJson(item: JSONObject): BackgroundDownloadJob {
    val scopesJson = item.optJSONArray("scopes") ?: JSONArray()
    val scopes = buildList {
      for (index in 0 until scopesJson.length()) add(scopesJson.optString(index))
    }
    return BackgroundDownloadJob(
      key = item.getString("key"),
      transferToken = item.getString("transferToken"),
      accountScope = item.getString("accountScope"),
      songId = item.getString("songId"),
      scopes = scopes,
      songJSON = item.getString("songJSON"),
      audioURL = item.getString("audioURL"),
      coverURL = item.optNullableString("coverURL"),
      lyricsURL = item.optNullableString("lyricsURL"),
      refreshURL = item.getString("refreshURL"),
      requestedAudioPath = item.getString("requestedAudioPath"),
      requestedCoverPath = item.optNullableString("requestedCoverPath"),
      requestedLyricsPath = item.optNullableString("requestedLyricsPath"),
      audioPath = item.optNullableString("audioPath"),
      coverPath = item.optNullableString("coverPath"),
      lyricsPath = item.optNullableString("lyricsPath"),
      status = item.optString("status", "queued"),
      progress = item.optDouble("progress", 0.0),
      bytesWritten = item.optLong("bytesWritten", 0),
      bytesExpected = item.optLong("bytesExpected", 0),
      error = item.optNullableString("error"),
      refreshAttempts = item.optInt("refreshAttempts", 0),
      pendingStage = item.optNullableString("pendingStage"),
      priority = item.optDouble("priority", 0.25),
      revision = item.optLong("revision", 1),
      updatedAt = item.optLong("updatedAt", 0),
    )
  }

  private fun ensureNotificationChannelLocked() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      NOTIFICATION_CHANNEL_ID,
      "Downloads",
      NotificationManager.IMPORTANCE_LOW,
    )
    channel.setShowBadge(false)
    manager.createNotificationChannel(channel)
  }

  companion object {
    const val NOTIFICATION_CHANNEL_ID = "background-downloads"
    const val UNIQUE_WORK_PREFIX = "bgdl:"

    @Volatile
    private var instance: BackgroundDownloadCoordinator? = null

    fun get(context: Context): BackgroundDownloadCoordinator {
      return instance ?: synchronized(this) {
        instance ?: BackgroundDownloadCoordinator(context.applicationContext).also { instance = it }
      }
    }

    fun nowMilliseconds(): Long = System.currentTimeMillis()

    fun isValidNetworkUrl(value: String): Boolean {
      return try {
        val uri = URI(value)
        val scheme = uri.scheme?.lowercase()
        (scheme == "http" || scheme == "https") && !uri.host.isNullOrEmpty()
      } catch (_: Exception) {
        false
      }
    }
  }
}

private fun JSONObject.optNullableString(key: String): String? {
  if (!has(key) || isNull(key)) return null
  val value = optString(key, "")
  return value.ifEmpty { null }
}

class BackgroundDownloadWorker(
  appContext: Context,
  params: androidx.work.WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val key = inputData.getString(KEY) ?: return Result.failure()
    val token = inputData.getString(TOKEN) ?: return Result.failure()
    val coordinator = BackgroundDownloadCoordinator.get(applicationContext)
    val job = coordinator.jobSnapshot(key, token) ?: return Result.success()
    if (job.status == "ready" || job.status == "error") return Result.success()

    setForegroundSafely(job)

    return try {
      runJob(coordinator, job)
      Result.success()
    } catch (_: StoppedDownloadException) {
      Result.success()
    } catch (error: HttpStatusException) {
      if (error.code in listOf(401, 403, 404) && job.refreshAttempts < 1 && job.refreshURL.isNotEmpty()) {
        try {
          refreshAndRetry(coordinator, job)
          Result.success()
        } catch (_: StoppedDownloadException) {
          Result.success()
        } catch (refreshError: Exception) {
          if (refreshError is kotlinx.coroutines.CancellationException) throw refreshError
          coordinator.markError(key, token, refreshError.message ?: "Download failed")
          Result.success()
        }
      } else {
        coordinator.markError(key, token, error.message ?: "Download failed")
        Result.success()
      }
    } catch (error: Exception) {
      if (error is kotlinx.coroutines.CancellationException) throw error
      if (isStopped) return Result.success()
      coordinator.markError(key, token, error.message ?: "Download failed")
      Result.success()
    }
  }

  private fun runJob(coordinator: BackgroundDownloadCoordinator, job: BackgroundDownloadJob) {
    val audioFile = coordinator.destinationFile(job.requestedAudioPath)
    if (!isValidFile(audioFile)) {
      downloadTo(coordinator, job, job.audioURL, audioFile, reportProgress = true)
    }
    if (isStopped) throw StoppedDownloadException()

    var coverPath: String? = null
    val requestedCover = job.requestedCoverPath
    val coverURL = job.coverURL
    if (!requestedCover.isNullOrEmpty() && !coverURL.isNullOrEmpty()) {
      val coverFile = coordinator.destinationFile(requestedCover)
      if (!isValidFile(coverFile)) {
        downloadTo(coordinator, job, coverURL, coverFile, reportProgress = false)
      }
      if (isValidFile(coverFile)) coverPath = requestedCover
    }
    if (isStopped) throw StoppedDownloadException()

    var lyricsPath: String? = null
    val requestedLyrics = job.requestedLyricsPath
    val lyricsURL = job.lyricsURL
    if (!requestedLyrics.isNullOrEmpty() && !lyricsURL.isNullOrEmpty()) {
      val lyricsFile = coordinator.destinationFile(requestedLyrics)
      if (!isValidFile(lyricsFile)) {
        downloadTo(coordinator, job, lyricsURL, lyricsFile, reportProgress = false)
      }
      if (isValidFile(lyricsFile)) lyricsPath = requestedLyrics
    }

    if (!isValidFile(audioFile)) {
      throw IllegalStateException("Audio download is empty")
    }
    coordinator.markReady(job.key, job.transferToken, job.requestedAudioPath, coverPath, lyricsPath)
  }

  private fun refreshAndRetry(coordinator: BackgroundDownloadCoordinator, job: BackgroundDownloadJob) {
    val body = httpGet(job.refreshURL)
    val json = JSONObject(body)
    val refreshedId = json.optString("id")
    if (refreshedId != job.songId) throw IllegalStateException("invalid refresh response")
    val audioValue = json.optString("audioUrl")
    val audioURL = absoluteUrl(audioValue, job.refreshURL)
      ?: throw IllegalStateException("invalid refresh response")
    if (!BackgroundDownloadCoordinator.isValidNetworkUrl(audioURL)) {
      throw IllegalStateException("invalid refresh response")
    }
    val coverURL = json.optString("imageUrl").takeIf { it.isNotEmpty() }?.let { absoluteUrl(it, job.refreshURL) }
      ?.takeIf { BackgroundDownloadCoordinator.isValidNetworkUrl(it) }
    val lyricsURL = json.optString("lyricsUrl").takeIf { it.isNotEmpty() }?.let { absoluteUrl(it, job.refreshURL) }
      ?.takeIf { BackgroundDownloadCoordinator.isValidNetworkUrl(it) }
    coordinator.applyRefresh(job.key, job.transferToken, audioURL, coverURL, lyricsURL, json.toString())
    val refreshed = coordinator.jobSnapshot(job.key, job.transferToken)
      ?: throw IllegalStateException("refresh lost the job")
    runJob(coordinator, refreshed)
  }

  private fun downloadTo(
    coordinator: BackgroundDownloadCoordinator,
    job: BackgroundDownloadJob,
    url: String,
    destination: File,
    reportProgress: Boolean,
  ) {
    val requestBuilder = Request.Builder().url(url)
    cookieHeader(url)?.let { requestBuilder.header("Cookie", it) }
    http.newCall(requestBuilder.build()).execute().use { response ->
      if (!response.isSuccessful) throw HttpStatusException(response.code, "HTTP ${response.code}")
      val body = response.body ?: throw IllegalStateException("empty body")
      val expected = body.contentLength()
      destination.parentFile?.mkdirs()
      val tmp = File(destination.parentFile, "${destination.name}.part")
      var written = 0L
      body.byteStream().use { input ->
        FileOutputStream(tmp).use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            if (isStopped) {
              tmp.delete()
              throw StoppedDownloadException()
            }
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            written += count
            if (reportProgress) {
              coordinator.markProgress(job.key, job.transferToken, written, expected)
            }
          }
        }
      }
      if (written <= 0L) {
        tmp.delete()
        throw IllegalStateException("empty download")
      }
      if (destination.exists()) destination.delete()
      if (!tmp.renameTo(destination)) {
        tmp.copyTo(destination, overwrite = true)
        tmp.delete()
      }
    }
  }

  private fun httpGet(url: String): String {
    val requestBuilder = Request.Builder().url(url)
    cookieHeader(url)?.let { requestBuilder.header("Cookie", it) }
    http.newCall(requestBuilder.build()).execute().use { response ->
      if (!response.isSuccessful) throw HttpStatusException(response.code, "HTTP ${response.code}")
      return response.body?.string() ?: throw IllegalStateException("empty refresh body")
    }
  }

  private suspend fun setForegroundSafely(job: BackgroundDownloadJob) {
    try {
      setForeground(foregroundInfo(job))
    } catch (_: Exception) {
      // Continue the transfer even if the host has not granted notifications.
    }
  }

  private fun cookieHeader(url: String): String? {
    return try {
      CookieManager.getInstance().getCookie(url)
    } catch (_: Exception) {
      null
    }
  }

  private fun isValidFile(file: File): Boolean = file.exists() && file.length() > 0

  private fun absoluteUrl(value: String, relativeTo: String): String? {
    if (BackgroundDownloadCoordinator.isValidNetworkUrl(value)) return value
    return try {
      URI(relativeTo).resolve(value).toString()
    } catch (_: Exception) {
      null
    }
  }

  private fun foregroundInfo(job: BackgroundDownloadJob): ForegroundInfo {
    val notification = NotificationCompat.Builder(applicationContext, BackgroundDownloadCoordinator.NOTIFICATION_CHANNEL_ID)
      .setContentTitle("Downloading music")
      .setContentText(job.songId)
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setOngoing(true)
      .setSilent(true)
      .build()
    val id = 0x1ead0000 or (job.key.hashCode() and 0xffff)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(id, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      ForegroundInfo(id, notification)
    }
  }

  companion object {
    const val KEY = "key"
    const val TOKEN = "transferToken"
    private val http: OkHttpClient = OkHttpClient.Builder()
      .connectTimeout(30, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.SECONDS)
      .writeTimeout(30, TimeUnit.SECONDS)
      .followRedirects(true)
      .build()
  }
}

private class HttpStatusException(val code: Int, message: String) : Exception(message)

private class StoppedDownloadException : Exception("stopped")
