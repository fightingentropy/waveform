import Foundation

struct BackgroundDownloadRequest {
  let key: String
  let transferToken: String
  let accountScope: String
  let songId: String
  let scopes: [String]
  let songJSON: String
  let audioURL: String
  let coverURL: String?
  let lyricsURL: String?
  let refreshURL: String
  let audioPath: String
  let coverPath: String?
  let lyricsPath: String?
  let priority: Double
}

struct BackgroundDownloadReference {
  let key: String
  let transferToken: String
}

struct BackgroundDownloadAcknowledgement {
  let key: String
  let transferToken: String
  let revision: Int64
}

private enum BackgroundDownloadStage: String, Codable {
  case audio
  case cover
  case lyrics
  case refresh
}

private struct BackgroundDownloadTaskDescription: Codable {
  let key: String
  let transferToken: String
  let stage: BackgroundDownloadStage
}

private struct BackgroundDownloadJob: Codable {
  var key: String
  var transferToken: String
  var accountScope: String
  var songId: String
  var scopes: [String]
  var songJSON: String
  var audioURL: String
  var coverURL: String?
  var lyricsURL: String?
  var refreshURL: String
  var requestedAudioPath: String
  var requestedCoverPath: String?
  var requestedLyricsPath: String?
  var audioPath: String?
  var coverPath: String?
  var lyricsPath: String?
  var status: String
  var progress: Double
  var bytesWritten: Int64
  var bytesExpected: Int64
  var error: String?
  var refreshAttempts: Int
  var pendingStage: BackgroundDownloadStage?
  var priority: Double
  var revision: Int64
  var updatedAt: Int64
}

private struct BackgroundDownloadLedger: Codable {
  var version: Int
  var activeAccount: String
  var jobs: [String: BackgroundDownloadJob]
}

private struct BackgroundDownloadJournalEntry: Codable {
  var version: Int
  var upserts: [BackgroundDownloadJob]
  var deletes: [String]
  var activeAccount: String?
}

/// A process-independent transport queue for offline songs.
///
/// Every audio task is submitted to one stable background URLSession as soon as
/// JS queues the collection. nsurlsessiond therefore owns the batch while React
/// Native is suspended. This singleton persists an outbox-style ledger and keeps
/// terminal entries until JS commits them to spotify-offline.db and acknowledges
/// the matching revision.
public final class BackgroundDownloadCoordinator: NSObject, URLSessionDownloadDelegate {
  public static let shared = BackgroundDownloadCoordinator()
  public static let stateChangedNotification = Notification.Name(
    "xyz.streamarena.spotify.background-downloads.state-changed"
  )

  public static var sessionIdentifier: String {
    let bundleIdentifier =
      Bundle.main.bundleIdentifier ?? "xyz.streamarena.spotify"
    return "\(bundleIdentifier).background-downloads.v1"
  }

  public static func handles(sessionIdentifier: String) -> Bool {
    sessionIdentifier == Self.sessionIdentifier
  }

  private let stateQueue = DispatchQueue(
    label: "xyz.streamarena.spotify.background-downloads.state",
    qos: .utility
  )
  private let delegateQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "xyz.streamarena.spotify.background-downloads.delegate"
    queue.maxConcurrentOperationCount = 1
    queue.qualityOfService = .utility
    return queue
  }()

  private var jobs: [String: BackgroundDownloadJob] = [:]
  private var activeAccount = "anonymous"
  private var ledgerTrustworthy = true
  private var activeTasks: [Int: URLSessionDownloadTask] = [:]
  private var restorationStarted = false
  private var reconcilingTasks = false
  private var completionHandlers: [() -> Void] = []
  private var backgroundEventsFinished = false
  private var handledTaskIdentifiers: Set<Int> = []
  private var lastNotifiedProgress: [String: Double] = [:]
  private var lastNotifiedAt: [String: TimeInterval] = [:]

  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.background(
      withIdentifier: Self.sessionIdentifier
    )
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.waitsForConnectivity = true
    configuration.allowsCellularAccess = true
    configuration.httpMaximumConnectionsPerHost = 2
    configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
    configuration.httpCookieStorage = HTTPCookieStorage.shared
    configuration.httpShouldSetCookies = true
    return URLSession(
      configuration: configuration,
      delegate: self,
      delegateQueue: delegateQueue
    )
  }()

  private override init() {
    super.init()
    let loaded = Self.readLedger()
    activeAccount = loaded.ledger.activeAccount
    jobs = loaded.ledger.jobs
    ledgerTrustworthy = loaded.trustworthy
  }

  // MARK: - Public lifecycle

  public func restoreSession() {
    stateQueue.async {
      try? self.compactLedgerIfNeededLocked()
      self.startRestorationLocked()
    }
  }

  public func handleEvents(
    forBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    guard Self.handles(sessionIdentifier: identifier) else {
      DispatchQueue.main.async(execute: completionHandler)
      return
    }
    // UIKit can deliver the session-finished delegate callback immediately in a
    // warm process. Register synchronously so it cannot overtake this handler.
    stateQueue.sync {
      self.completionHandlers.append(completionHandler)
      self.startRestorationLocked()
      self.finishBackgroundEventsIfPossibleLocked()
    }
  }

  // MARK: - Public module API

  func enqueue(_ requests: [BackgroundDownloadRequest]) throws {
    try stateQueue.sync {
      guard !requests.isEmpty else {
        startRestorationLocked()
        return
      }

      // Validate every destination before mutating the durable ledger. A malformed
      // JS payload must fail the whole bridge call instead of leaving half a batch.
      for request in requests {
        guard
          !request.key.isEmpty,
          !request.transferToken.isEmpty,
          !request.accountScope.isEmpty,
          !request.songId.isEmpty,
          isValidNetworkURL(request.audioURL),
          isValidNetworkURL(request.refreshURL),
          request.coverURL.map(isValidNetworkURL) ?? true,
          request.lyricsURL.map(isValidNetworkURL) ?? true
        else {
          throw BackgroundDownloadCoordinatorError.invalidRequest
        }
        _ = try destinationURL(for: request.audioPath)
        if let coverPath = request.coverPath {
          _ = try destinationURL(for: coverPath)
        }
        if let lyricsPath = request.lyricsPath {
          _ = try destinationURL(for: lyricsPath)
        }
      }

      startRestorationLocked()
      var obsoleteTasks: [Int: URLSessionDownloadTask] = [:]
      var previousJobs: [String: BackgroundDownloadJob] = [:]
      for request in requests where previousJobs[request.key] == nil {
        previousJobs[request.key] = jobs[request.key]
      }
      let now = Self.nowMilliseconds()

      for request in requests {
        let existing = jobs[request.key]
        if
          let existing,
          existing.transferToken == request.transferToken
        {
          var updated = existing
          updated.accountScope = request.accountScope
          updated.songId = request.songId
          updated.scopes = request.scopes
          updated.songJSON = request.songJSON
          updated.audioURL = request.audioURL
          updated.coverURL = request.coverURL
          updated.lyricsURL = request.lyricsURL
          updated.refreshURL = request.refreshURL
          updated.requestedAudioPath = request.audioPath
          updated.requestedCoverPath = request.coverPath
          updated.requestedLyricsPath = request.lyricsPath
          updated.priority = request.priority
          updated.updatedAt = now
          jobs[request.key] = updated
          for task in activeTasks.values {
            guard
              let description = taskDescription(for: task),
              description.key == request.key,
              description.transferToken == request.transferToken
            else {
              continue
            }
            task.priority = Float(max(0.05, min(request.priority, 1)))
          }
          continue
        }

        for task in activeTasks.values {
          guard
            let description = taskDescription(for: task),
            description.key == request.key,
            description.transferToken != request.transferToken
          else {
            continue
          }
          obsoleteTasks[task.taskIdentifier] = task
        }

        jobs[request.key] = BackgroundDownloadJob(
          key: request.key,
          transferToken: request.transferToken,
          accountScope: request.accountScope,
          songId: request.songId,
          scopes: request.scopes,
          songJSON: request.songJSON,
          audioURL: request.audioURL,
          coverURL: request.coverURL,
          lyricsURL: request.lyricsURL,
          refreshURL: request.refreshURL,
          requestedAudioPath: request.audioPath,
          requestedCoverPath: request.coverPath,
          requestedLyricsPath: request.lyricsPath,
          audioPath: nil,
          coverPath: nil,
          lyricsPath: nil,
          status: "queued",
          progress: 0,
          bytesWritten: 0,
          bytesExpected: 0,
          error: nil,
          refreshAttempts: 0,
          pendingStage: nil,
          priority: request.priority,
          revision: 1,
          updatedAt: now
        )
      }

      do {
        try appendLedgerLocked(
          upserts: requests.compactMap { jobs[$0.key] }
        )
        ledgerTrustworthy = true
      } catch {
        for request in requests {
          if let previous = previousJobs[request.key] {
            jobs[request.key] = previous
          } else {
            jobs.removeValue(forKey: request.key)
          }
        }
        throw error
      }

      // The replacement ledger is already durable, so a late callback from one of
      // these tasks cannot revive the old transfer token even if cancellation races.
      for task in obsoleteTasks.values {
        activeTasks.removeValue(forKey: task.taskIdentifier)
        task.cancel()
      }

      if !reconcilingTasks {
        scheduleAllJobsLocked()
      }
    }
  }

  func cancel(_ references: [BackgroundDownloadReference]) throws {
    try stateQueue.sync {
      guard !references.isEmpty else { return }
      var targets: [String: String] = [:]
      for reference in references {
        targets[reference.key] = reference.transferToken
      }
      let removedKeys = Set(
        jobs.compactMap { key, job in
          targets[key] == job.transferToken ? key : nil
        }
      )
      guard !removedKeys.isEmpty else { return }

      // Removing the ledger entries is the tombstone. Persist it before cancelling
      // native tasks so any callback that wins the race is ignored.
      try appendLedgerLocked(deletes: Array(removedKeys))
      for key in removedKeys {
        jobs.removeValue(forKey: key)
        lastNotifiedProgress.removeValue(forKey: key)
        lastNotifiedAt.removeValue(forKey: key)
      }
      cancelTasksLocked(keys: removedKeys)
    }
  }

  func cancelAccount(_ accountScope: String) throws {
    try stateQueue.sync {
      let keys = Set(
        jobs.compactMap { key, job in
          job.accountScope == accountScope ? key : nil
        }
      )
      guard !keys.isEmpty else { return }
      try appendLedgerLocked(deletes: Array(keys))
      for key in keys {
        jobs.removeValue(forKey: key)
        lastNotifiedProgress.removeValue(forKey: key)
        lastNotifiedAt.removeValue(forKey: key)
      }
      cancelTasksLocked(keys: keys)
    }
  }

  func cancelAll() throws {
    try stateQueue.sync {
      let keys = Set(jobs.keys)
      try appendLedgerLocked(deletes: Array(keys))
      jobs.removeAll()
      lastNotifiedProgress.removeAll()
      lastNotifiedAt.removeAll()
      cancelTasksLocked(keys: keys)
    }
  }

  func snapshot(accountScope: String?) -> [[String: Any]] {
    stateQueue.sync {
      startRestorationLocked()
      return jobs.values
        .filter { accountScope == nil || $0.accountScope == accountScope }
        .sorted {
          if $0.updatedAt == $1.updatedAt { return $0.key < $1.key }
          return $0.updatedAt < $1.updatedAt
        }
        .map(snapshotDictionary)
    }
  }

  func acknowledge(
    _ acknowledgements: [BackgroundDownloadAcknowledgement]
  ) throws {
    try stateQueue.sync {
      var removedKeys: [String] = []
      for acknowledgement in acknowledgements {
        guard
          let job = jobs[acknowledgement.key],
          job.transferToken == acknowledgement.transferToken,
          job.revision == acknowledgement.revision,
          job.status == "ready" || job.status == "error"
        else {
          continue
        }
        removedKeys.append(acknowledgement.key)
      }
      if !removedKeys.isEmpty {
        try appendLedgerLocked(deletes: removedKeys)
        for key in removedKeys {
          jobs.removeValue(forKey: key)
          lastNotifiedProgress.removeValue(forKey: key)
          lastNotifiedAt.removeValue(forKey: key)
        }
      }
    }
  }

  func setActiveAccount(_ accountScope: String) throws {
    try stateQueue.sync {
      let nextAccount = accountScope.isEmpty ? "anonymous" : accountScope
      try appendLedgerLocked(activeAccount: nextAccount)
      activeAccount = nextAccount
      startRestorationLocked()

      for task in activeTasks.values {
        guard
          let description = taskDescription(for: task),
          let job = jobs[description.key]
        else {
          continue
        }
        if job.accountScope == activeAccount {
          if task.state == .suspended { task.resume() }
        } else if task.state == .running {
          task.suspend()
        }
      }

      if !reconcilingTasks {
        scheduleAllJobsLocked()
      }
    }
  }

  // MARK: - Session restoration and scheduling

  private func startRestorationLocked() {
    guard !restorationStarted else { return }
    restorationStarted = true
    reconcilingTasks = true
    let backgroundSession = session
    backgroundSession.getAllTasks { tasks in
      self.stateQueue.async {
        self.reconcileTasksLocked(tasks)
      }
    }
  }

  private func reconcileTasksLocked(_ tasks: [URLSessionTask]) {
    var signatures: [String: Int] = [:]
    for task in activeTasks.values where task.state != .completed && task.state != .canceling {
      guard let description = taskDescription(for: task) else { continue }
      signatures[taskSignature(description)] = task.taskIdentifier
    }

    for task in tasks {
      if
        !ledgerTrustworthy,
        let downloadTask = task as? URLSessionDownloadTask,
        let description = taskDescription(for: downloadTask),
        jobs[description.key] == nil
      {
        activeTasks[task.taskIdentifier] = downloadTask
        if task.state == .running { task.suspend() }
        continue
      }
      guard
        let downloadTask = task as? URLSessionDownloadTask,
        let description = taskDescription(for: downloadTask),
        let job = jobs[description.key],
        job.transferToken == description.transferToken,
        job.status != "ready",
        job.status != "error",
        task.state != .completed,
        task.state != .canceling
      else {
        activeTasks.removeValue(forKey: task.taskIdentifier)
        task.cancel()
        continue
      }
      let signature = taskSignature(description)
      if
        let existingIdentifier = signatures[signature],
        existingIdentifier != task.taskIdentifier
      {
        task.cancel()
        continue
      }
      signatures[signature] = task.taskIdentifier
      activeTasks[task.taskIdentifier] = downloadTask
      if var updated = jobs[description.key] {
        updated.pendingStage = description.stage
        jobs[description.key] = updated
      }
      if job.accountScope == activeAccount {
        if task.state == .suspended { task.resume() }
      } else if task.state == .running {
        task.suspend()
      }
    }

    reconcilingTasks = false
    scheduleAllJobsLocked()
    finishBackgroundEventsIfPossibleLocked()
  }

  private func scheduleAllJobsLocked() {
    let orderedKeys = jobs.values
      .filter {
        $0.accountScope == activeAccount &&
          $0.status != "ready" &&
          $0.status != "error"
      }
      .sorted {
        if $0.priority == $1.priority {
          if $0.updatedAt == $1.updatedAt { return $0.key < $1.key }
          return $0.updatedAt < $1.updatedAt
        }
        return $0.priority > $1.priority
      }
      .map(\.key)

    for key in orderedKeys {
      do {
        try scheduleJobLocked(key)
      } catch {
        guard var job = jobs[key] else { continue }
        markErrorLocked(&job, message: error.localizedDescription)
      }
    }
  }

  private func scheduleJobLocked(_ key: String) throws {
    guard var job = jobs[key] else { return }
    guard job.accountScope == activeAccount else { return }
    guard job.status != "ready", job.status != "error" else { return }
    guard !hasActiveTaskLocked(key: key, transferToken: job.transferToken) else {
      return
    }

    if job.pendingStage == .refresh {
      try startTaskLocked(
        job: &job,
        stage: .refresh,
        urlString: job.refreshURL
      )
      return
    }

    if
      job.audioPath != job.requestedAudioPath ||
      !isValidDownloadedFile(relativePath: job.requestedAudioPath)
    {
      job.audioPath = nil
      job.coverPath = nil
      job.lyricsPath = nil
      try startTaskLocked(job: &job, stage: .audio, urlString: job.audioURL)
      return
    }
    job.audioPath = job.requestedAudioPath

    if
      let coverURL = job.coverURL,
      !coverURL.isEmpty,
      let coverPath = job.requestedCoverPath,
      (
        job.coverPath != coverPath ||
          !isValidDownloadedFile(relativePath: coverPath)
      )
    {
      job.coverPath = nil
      jobs[key] = job
      try startTaskLocked(job: &job, stage: .cover, urlString: coverURL)
      return
    }
    if
      let coverPath = job.requestedCoverPath,
      isValidDownloadedFile(relativePath: coverPath)
    {
      job.coverPath = coverPath
    }

    if
      let lyricsURL = job.lyricsURL,
      !lyricsURL.isEmpty,
      let lyricsPath = job.requestedLyricsPath,
      (
        job.lyricsPath != lyricsPath ||
          !isValidDownloadedFile(relativePath: lyricsPath)
      )
    {
      job.lyricsPath = nil
      jobs[key] = job
      try startTaskLocked(job: &job, stage: .lyrics, urlString: lyricsURL)
      return
    }
    if
      let lyricsPath = job.requestedLyricsPath,
      isValidDownloadedFile(relativePath: lyricsPath)
    {
      job.lyricsPath = lyricsPath
    }

    markReadyLocked(&job)
  }

  private func startTaskLocked(
    job: inout BackgroundDownloadJob,
    stage: BackgroundDownloadStage,
    urlString: String
  ) throws {
    guard let url = URL(string: urlString) else {
      throw BackgroundDownloadCoordinatorError.invalidURL
    }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.httpShouldHandleCookies = true
    request.timeoutInterval = 7 * 24 * 60 * 60

    let task = session.downloadTask(with: request)
    let description = BackgroundDownloadTaskDescription(
      key: job.key,
      transferToken: job.transferToken,
      stage: stage
    )
    task.taskDescription = try encodeTaskDescription(description)
    task.priority = Float(max(0.05, min(job.priority, 1)))
    activeTasks[task.taskIdentifier] = task
    job.pendingStage = stage

    if stage == .audio || stage == .refresh {
      job.status = "queued"
    } else {
      // Sidecars are tiny follow-up phases of the same song download. Keep the
      // row in its active state instead of flashing back to "queued".
      job.status = "downloading"
    }
    job.error = nil
    job.updatedAt = Self.nowMilliseconds()
    jobs[job.key] = job
    // The complete job manifest is persisted before scheduleAllJobsLocked runs.
    // Persisting the same large ledger once per task would turn a 1,359-song
    // collection into quadratic disk I/O. Later phases likewise persist their
    // updated job before asking this method to create the next native task.
    task.resume()
  }

  private func hasActiveTaskLocked(
    key: String,
    transferToken: String
  ) -> Bool {
    activeTasks.values.contains {
      guard let description = taskDescription(for: $0) else { return false }
      return description.key == key &&
        description.transferToken == transferToken
    }
  }

  private func cancelTasksLocked(keys: Set<String>) {
    let matches = activeTasks.compactMap { identifier, task -> (Int, URLSessionDownloadTask)? in
      guard
        let description = taskDescription(for: task),
        keys.contains(description.key)
      else {
        return nil
      }
      return (identifier, task)
    }
    for (identifier, task) in matches {
      activeTasks.removeValue(forKey: identifier)
      task.cancel()
    }
  }

  // MARK: - URLSession delegates

  public func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    stateQueue.async {
      guard
        let description = self.taskDescription(for: downloadTask),
        description.stage == .audio,
        var job = self.jobs[description.key],
        job.transferToken == description.transferToken,
        job.status != "ready",
        job.status != "error",
        job.pendingStage == .audio ||
          (job.pendingStage == nil && self.reconcilingTasks)
      else {
        return
      }

      let becameActive = job.status != "downloading"
      job.status = "downloading"
      job.bytesWritten = totalBytesWritten
      job.bytesExpected = max(totalBytesExpectedToWrite, 0)
      if totalBytesExpectedToWrite > 0 {
        job.progress = min(
          0.99,
          max(0, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
        )
      }
      if becameActive {
        job.revision += 1
        job.updatedAt = Self.nowMilliseconds()
      }
      self.jobs[job.key] = job

      let now = Date.timeIntervalSinceReferenceDate
      let lastProgress = self.lastNotifiedProgress[job.key] ?? -1
      let lastTime = self.lastNotifiedAt[job.key] ?? 0
      if
        becameActive ||
        abs(job.progress - lastProgress) >= 0.02 ||
        now - lastTime >= 0.25
      {
        self.lastNotifiedProgress[job.key] = job.progress
        self.lastNotifiedAt[job.key] = now
        self.notifyLocked(job)
      }
    }
  }

  public func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    // The temporary file is only valid until this delegate returns. Move/read it
    // synchronously on our serialized state queue before yielding to URLSession.
    stateQueue.sync {
      guard
        let description = taskDescription(for: downloadTask),
        var job = jobs[description.key],
        job.transferToken == description.transferToken,
        job.status != "ready",
        job.status != "error",
        job.pendingStage == description.stage ||
          (job.pendingStage == nil && reconcilingTasks)
      else {
        activeTasks.removeValue(forKey: downloadTask.taskIdentifier)
        handledTaskIdentifiers.insert(downloadTask.taskIdentifier)
        try? FileManager.default.removeItem(at: location)
        return
      }
      activeTasks.removeValue(forKey: downloadTask.taskIdentifier)
      handledTaskIdentifiers.insert(downloadTask.taskIdentifier)
      job.pendingStage = nil

      let response = downloadTask.response as? HTTPURLResponse
      let statusCode = response?.statusCode ?? 0
      guard (200...299).contains(statusCode) else {
        try? FileManager.default.removeItem(at: location)
        handleFailureLocked(
          job: &job,
          stage: description.stage,
          message: "Download failed with HTTP \(statusCode)",
          statusCode: statusCode
        )
        return
      }

      do {
        switch description.stage {
        case .audio:
          try moveDownloadedFile(
            from: location,
            toRelativePath: job.requestedAudioPath
          )
          job.audioPath = job.requestedAudioPath
          job.progress = 0.99
          job.bytesWritten = max(
            job.bytesWritten,
            fileSize(relativePath: job.requestedAudioPath)
          )
          jobs[job.key] = job
          try appendLedgerLocked(upserts: [job])
          try scheduleJobLocked(job.key)

        case .cover:
          if let coverPath = job.requestedCoverPath {
            try moveDownloadedFile(from: location, toRelativePath: coverPath)
            job.coverPath = coverPath
          }
          jobs[job.key] = job
          try appendLedgerLocked(upserts: [job])
          try scheduleJobLocked(job.key)

        case .lyrics:
          if let lyricsPath = job.requestedLyricsPath {
            try moveDownloadedFile(from: location, toRelativePath: lyricsPath)
            job.lyricsPath = lyricsPath
          }
          jobs[job.key] = job
          try appendLedgerLocked(upserts: [job])
          try scheduleJobLocked(job.key)

        case .refresh:
          try applyRefreshedSongLocked(from: location, to: &job)
          jobs[job.key] = job
          try appendLedgerLocked(upserts: [job])
          try scheduleJobLocked(job.key)
        }
      } catch {
        try? FileManager.default.removeItem(at: location)
        handleFailureLocked(
          job: &job,
          stage: description.stage,
          message: error.localizedDescription,
          statusCode: nil
        )
      }
    }
  }

  public func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    stateQueue.async {
      self.activeTasks.removeValue(forKey: task.taskIdentifier)
      if self.handledTaskIdentifiers.remove(task.taskIdentifier) != nil {
        return
      }
      guard let error else { return }
      guard
        let description = self.taskDescription(for: task),
        var job = self.jobs[description.key],
        job.transferToken == description.transferToken,
        job.status != "ready",
        job.status != "error",
        job.pendingStage == description.stage ||
          (job.pendingStage == nil && self.reconcilingTasks)
      else {
        return
      }
      self.handleFailureLocked(
        job: &job,
        stage: description.stage,
        message: error.localizedDescription,
        statusCode: nil
      )
    }
  }

  public func urlSessionDidFinishEvents(
    forBackgroundURLSession session: URLSession
  ) {
    stateQueue.async {
      self.backgroundEventsFinished = true
      self.finishBackgroundEventsIfPossibleLocked()
    }
  }

  private func finishBackgroundEventsIfPossibleLocked() {
    guard backgroundEventsFinished, !reconcilingTasks else { return }
    let handlers = completionHandlers
    completionHandlers.removeAll()
    backgroundEventsFinished = false
    guard !handlers.isEmpty else { return }
    DispatchQueue.main.async {
      for handler in handlers {
        handler()
      }
    }
  }

  // MARK: - Completion / retry state

  private func handleFailureLocked(
    job: inout BackgroundDownloadJob,
    stage: BackgroundDownloadStage,
    message: String,
    statusCode: Int?
  ) {
    job.pendingStage = nil
    if
      stage == .audio,
      let statusCode,
      [401, 403, 404].contains(statusCode),
      job.refreshAttempts < 1,
      !job.refreshURL.isEmpty
    {
      job.refreshAttempts += 1
      job.status = "queued"
      job.error = nil
      job.progress = 0
      job.bytesWritten = 0
      job.bytesExpected = 0
      job.pendingStage = .refresh
      job.revision += 1
      job.updatedAt = Self.nowMilliseconds()
      jobs[job.key] = job
      do {
        try appendLedgerLocked(upserts: [job])
        try startTaskLocked(
          job: &job,
          stage: .refresh,
          urlString: job.refreshURL
        )
      } catch {
        markErrorLocked(&job, message: error.localizedDescription)
      }
      return
    }

    // Artwork and lyrics are best-effort sidecars. A failed sidecar must not
    // strand valid audio or block the rest of a large collection.
    if stage == .cover {
      job.coverURL = nil
      job.requestedCoverPath = nil
      jobs[job.key] = job
      try? appendLedgerLocked(upserts: [job])
      try? scheduleJobLocked(job.key)
      return
    }
    if stage == .lyrics {
      job.lyricsURL = nil
      job.requestedLyricsPath = nil
      jobs[job.key] = job
      try? appendLedgerLocked(upserts: [job])
      try? scheduleJobLocked(job.key)
      return
    }

    markErrorLocked(&job, message: message)
  }

  private func markReadyLocked(_ job: inout BackgroundDownloadJob) {
    guard isValidDownloadedFile(relativePath: job.requestedAudioPath) else {
      markErrorLocked(&job, message: "Downloaded audio file is missing or empty")
      return
    }
    job.status = "ready"
    job.progress = 1
    job.audioPath = job.requestedAudioPath
    job.error = nil
    job.pendingStage = nil
    job.revision += 1
    job.updatedAt = Self.nowMilliseconds()
    jobs[job.key] = job
    try? appendLedgerLocked(upserts: [job])
    notifyLocked(job)
  }

  private func markErrorLocked(
    _ job: inout BackgroundDownloadJob,
    message: String
  ) {
    job.status = "error"
    job.progress = 0
    job.error = message
    job.pendingStage = nil
    job.revision += 1
    job.updatedAt = Self.nowMilliseconds()
    jobs[job.key] = job
    try? appendLedgerLocked(upserts: [job])
    notifyLocked(job)
  }

  private func applyRefreshedSongLocked(
    from location: URL,
    to job: inout BackgroundDownloadJob
  ) throws {
    let data = try Data(contentsOf: location)
    guard
      let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let refreshedSongId = json["id"] as? String,
      refreshedSongId == job.songId,
      let audioValue = json["audioUrl"] as? String,
      let audioURL = absoluteURLString(
        audioValue,
        relativeTo: job.refreshURL
      ),
      isValidNetworkURL(audioURL)
    else {
      throw BackgroundDownloadCoordinatorError.invalidRefreshResponse
    }

    job.audioURL = audioURL
    if
      let coverValue = json["imageUrl"] as? String,
      !coverValue.isEmpty,
      let coverURL = absoluteURLString(
        coverValue,
        relativeTo: job.refreshURL
      ),
      isValidNetworkURL(coverURL)
    {
      job.coverURL = coverURL
    } else {
      job.coverURL = nil
      job.requestedCoverPath = nil
    }
    if
      let lyricsValue = json["lyricsUrl"] as? String,
      !lyricsValue.isEmpty,
      let lyricsURL = absoluteURLString(
        lyricsValue,
        relativeTo: job.refreshURL
      ),
      isValidNetworkURL(lyricsURL)
    {
      job.lyricsURL = lyricsURL
    } else {
      job.lyricsURL = nil
      job.requestedLyricsPath = nil
    }
    if let refreshedData = try? JSONSerialization.data(
      withJSONObject: json,
      options: [.sortedKeys]
    ), let refreshedJSON = String(data: refreshedData, encoding: .utf8) {
      job.songJSON = refreshedJSON
    }
    job.status = "queued"
    job.error = nil
    job.progress = 0
    job.bytesWritten = 0
    job.bytesExpected = 0
    job.pendingStage = nil
    job.revision += 1
    job.updatedAt = Self.nowMilliseconds()
  }

  // MARK: - Persistence and files

  private static var ledgerURL: URL {
    let root =
      FileManager.default.urls(
        for: .applicationSupportDirectory,
        in: .userDomainMask
      ).first ??
      FileManager.default.temporaryDirectory
    return root
      .appendingPathComponent("BackgroundDownloads", isDirectory: true)
      .appendingPathComponent("ledger-v1.json", isDirectory: false)
  }

  private static var journalURL: URL {
    ledgerURL
      .deletingLastPathComponent()
      .appendingPathComponent("journal-v1.ndjson", isDirectory: false)
  }

  private static func readLedger() -> (
    ledger: BackgroundDownloadLedger,
    trustworthy: Bool
  ) {
    var ledger = BackgroundDownloadLedger(
      version: 1,
      activeAccount: "anonymous",
      jobs: [:]
    )
    let fileManager = FileManager.default
    if fileManager.fileExists(atPath: ledgerURL.path) {
      do {
        let data = try Data(contentsOf: ledgerURL)
        ledger = try JSONDecoder().decode(
          BackgroundDownloadLedger.self,
          from: data
        )
        guard ledger.version == 1 else {
          throw BackgroundDownloadCoordinatorError.unsupportedLedger
        }
      } catch {
        // Preserve daemon-owned tasks rather than treating an unreadable
        // protected/corrupt snapshot as an authoritative empty ledger.
        return (ledger, false)
      }
    }

    guard fileManager.fileExists(atPath: journalURL.path) else {
      return (ledger, true)
    }
    do {
      let data = try Data(contentsOf: journalURL)
      let endsWithNewline = data.last == 0x0A
      let lines = data.split(
        separator: 0x0A,
        omittingEmptySubsequences: true
      )
      for (index, line) in lines.enumerated() {
        do {
          let entry = try JSONDecoder().decode(
            BackgroundDownloadJournalEntry.self,
            from: Data(line)
          )
          guard entry.version == 1 else {
            throw BackgroundDownloadCoordinatorError.unsupportedLedger
          }
          if let account = entry.activeAccount {
            ledger.activeAccount = account
          }
          for key in entry.deletes {
            ledger.jobs.removeValue(forKey: key)
          }
          for job in entry.upserts {
            ledger.jobs[job.key] = job
          }
        } catch {
          // A process death can leave only the final append incomplete. Every
          // prior newline-delimited transaction is still valid and replayable.
          if index == lines.count - 1 && !endsWithNewline {
            break
          }
          return (ledger, false)
        }
      }
    } catch {
      return (ledger, false)
    }
    return (ledger, true)
  }

  private func appendLedgerLocked(
    upserts: [BackgroundDownloadJob] = [],
    deletes: [String] = [],
    activeAccount nextActiveAccount: String? = nil
  ) throws {
    guard
      !upserts.isEmpty ||
        !deletes.isEmpty ||
        nextActiveAccount != nil
    else {
      return
    }
    let entry = BackgroundDownloadJournalEntry(
      version: 1,
      upserts: upserts,
      deletes: deletes,
      activeAccount: nextActiveAccount
    )
    var data = try JSONEncoder().encode(entry)
    data.append(0x0A)
    let directory = Self.journalURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    if !FileManager.default.fileExists(atPath: Self.journalURL.path) {
      guard FileManager.default.createFile(
        atPath: Self.journalURL.path,
        contents: nil
      ) else {
        throw BackgroundDownloadCoordinatorError.ledgerWriteFailed
      }
    }
    let handle = try FileHandle(forWritingTo: Self.journalURL)
    defer { try? handle.close() }
    try handle.seekToEnd()
    try handle.write(contentsOf: data)
    try handle.synchronize()
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: directory.path
    )
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: Self.journalURL.path
    )

  }

  private func compactLedgerLocked() throws {
    let ledger = BackgroundDownloadLedger(
      version: 1,
      activeAccount: activeAccount,
      jobs: jobs
    )
    let data = try JSONEncoder().encode(ledger)
    let directory = Self.ledgerURL.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: directory.path
    )
    try data.write(to: Self.ledgerURL, options: [.atomic])
    try Data().write(to: Self.journalURL, options: [.atomic])
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: Self.ledgerURL.path
    )
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: Self.journalURL.path
    )
  }

  private func compactLedgerIfNeededLocked() throws {
    let attributes = try? FileManager.default.attributesOfItem(
      atPath: Self.journalURL.path
    )
    let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
    if size > 16 * 1024 * 1024 {
      try compactLedgerLocked()
    }
  }

  private func destinationURL(for relativePath: String) throws -> URL {
    guard
      relativePath.hasPrefix("offline-media/"),
      !relativePath.hasPrefix("/"),
      !relativePath.split(separator: "/").contains("..")
    else {
      throw BackgroundDownloadCoordinatorError.invalidDestination
    }
    guard
      let documents = FileManager.default.urls(
        for: .documentDirectory,
        in: .userDomainMask
      ).first
    else {
      throw BackgroundDownloadCoordinatorError.missingDocumentsDirectory
    }
    let root = documents.standardizedFileURL
    let destination = root
      .appendingPathComponent(relativePath, isDirectory: false)
      .standardizedFileURL
    guard destination.path.hasPrefix(root.path + "/") else {
      throw BackgroundDownloadCoordinatorError.invalidDestination
    }
    return destination
  }

  private func moveDownloadedFile(
    from temporaryURL: URL,
    toRelativePath relativePath: String
  ) throws {
    let destination = try destinationURL(for: relativePath)
    let directory = destination.deletingLastPathComponent()
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    var directoryValues = URLResourceValues()
    directoryValues.isExcludedFromBackup = true
    var mutableDirectory = directory
    try? mutableDirectory.setResourceValues(directoryValues)
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: directory.path
    )
    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    try FileManager.default.moveItem(at: temporaryURL, to: destination)
    let size = fileSize(relativePath: relativePath)
    guard size > 0 else {
      try? FileManager.default.removeItem(at: destination)
      throw BackgroundDownloadCoordinatorError.emptyDownload
    }
    try? FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: destination.path
    )
  }

  private func fileSize(relativePath: String) -> Int64 {
    guard let url = try? destinationURL(for: relativePath) else { return 0 }
    guard
      let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
      let value = attributes[.size] as? NSNumber
    else {
      return 0
    }
    return value.int64Value
  }

  private func isValidDownloadedFile(relativePath: String) -> Bool {
    fileSize(relativePath: relativePath) > 0
  }

  // MARK: - Bridge payloads / task descriptions

  private func snapshotDictionary(
    _ job: BackgroundDownloadJob
  ) -> [String: Any] {
    var payload: [String: Any] = [
      "key": job.key,
      "transferToken": job.transferToken,
      "accountScope": job.accountScope,
      "songId": job.songId,
      "scopes": job.scopes,
      "songJSON": job.songJSON,
      "status": job.status,
      "progress": job.progress,
      "bytesWritten": job.bytesWritten,
      "bytesExpected": job.bytesExpected,
      "revision": job.revision,
      "updatedAt": job.updatedAt
    ]
    if let audioPath = job.audioPath {
      payload["audioPath"] = audioPath
    }
    if let coverPath = job.coverPath {
      payload["coverPath"] = coverPath
    }
    if let lyricsPath = job.lyricsPath {
      payload["lyricsPath"] = lyricsPath
    }
    if let error = job.error {
      payload["error"] = error
    }
    return payload
  }

  private func notifyLocked(_ job: BackgroundDownloadJob) {
    NotificationCenter.default.post(
      name: Self.stateChangedNotification,
      object: nil,
      userInfo: snapshotDictionary(job)
    )
  }

  private func encodeTaskDescription(
    _ description: BackgroundDownloadTaskDescription
  ) throws -> String {
    let data = try JSONEncoder().encode(description)
    guard let string = String(data: data, encoding: .utf8) else {
      throw BackgroundDownloadCoordinatorError.invalidTaskDescription
    }
    return string
  }

  private func taskDescription(
    for task: URLSessionTask
  ) -> BackgroundDownloadTaskDescription? {
    guard
      let value = task.taskDescription,
      let data = value.data(using: .utf8)
    else {
      return nil
    }
    return try? JSONDecoder().decode(
      BackgroundDownloadTaskDescription.self,
      from: data
    )
  }

  private func taskSignature(
    _ description: BackgroundDownloadTaskDescription
  ) -> String {
    "\(description.key)\u{0}\(description.transferToken)\u{0}\(description.stage.rawValue)"
  }

  private func isValidNetworkURL(_ value: String) -> Bool {
    guard
      let url = URL(string: value),
      let scheme = url.scheme?.lowercased(),
      scheme == "http" || scheme == "https",
      url.host != nil
    else {
      return false
    }
    return true
  }

  private func absoluteURLString(
    _ value: String,
    relativeTo baseValue: String
  ) -> String? {
    if let absolute = URL(string: value), absolute.scheme != nil {
      return absolute.absoluteString
    }
    guard let baseURL = URL(string: baseValue) else { return nil }
    return URL(string: value, relativeTo: baseURL)?.absoluteURL.absoluteString
  }

  private static func nowMilliseconds() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1000)
  }
}

private enum BackgroundDownloadCoordinatorError: LocalizedError {
  case invalidRequest
  case invalidURL
  case invalidDestination
  case missingDocumentsDirectory
  case emptyDownload
  case invalidRefreshResponse
  case invalidTaskDescription
  case unsupportedLedger
  case ledgerWriteFailed

  var errorDescription: String? {
    switch self {
    case .invalidRequest:
      return "Invalid background download request"
    case .invalidURL:
      return "Invalid background download URL"
    case .invalidDestination:
      return "Invalid background download destination"
    case .missingDocumentsDirectory:
      return "Documents directory is unavailable"
    case .emptyDownload:
      return "Downloaded file is empty"
    case .invalidRefreshResponse:
      return "Could not refresh the media URL"
    case .invalidTaskDescription:
      return "Could not persist the background task"
    case .unsupportedLedger:
      return "Unsupported background download ledger"
    case .ledgerWriteFailed:
      return "Could not persist the background download ledger"
    }
  }
}
