import ExpoModulesCore
import Foundation

struct BackgroundDownloadRequestRecord: Record {
  @Field var key: String = ""
  @Field var transferToken: String = ""
  @Field var accountScope: String = ""
  @Field var songId: String = ""
  @Field var scopes: [String] = []
  @Field var songJSON: String = ""
  @Field var audioURL: String = ""
  @Field var coverURL: String?
  @Field var lyricsURL: String?
  @Field var refreshURL: String = ""
  @Field var audioPath: String = ""
  @Field var coverPath: String?
  @Field var lyricsPath: String?
  @Field var priority: Double = 0.25
}

struct BackgroundDownloadReferenceRecord: Record {
  @Field var key: String = ""
  @Field var transferToken: String = ""
}

struct BackgroundDownloadAcknowledgementRecord: Record {
  @Field var key: String = ""
  @Field var transferToken: String = ""
  @Field var revision: Int64 = 0
}

public final class BackgroundDownloadsModule: Module {
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("BackgroundDownloads")

    Events("stateChanged")

    OnCreate {
      self.observer = NotificationCenter.default.addObserver(
        forName: BackgroundDownloadCoordinator.stateChangedNotification,
        object: nil,
        queue: .main
      ) { [weak self] notification in
        guard
          let self,
          let payload = notification.userInfo as? [String: Any]
        else {
          return
        }
        self.sendEvent("stateChanged", payload)
      }
      BackgroundDownloadCoordinator.shared.restoreSession()
    }

    OnDestroy {
      if let observer = self.observer {
        NotificationCenter.default.removeObserver(observer)
      }
      self.observer = nil
    }

    AsyncFunction("enqueue") { (records: [BackgroundDownloadRequestRecord]) in
      let jobs = records.map {
        BackgroundDownloadRequest(
          key: $0.key,
          transferToken: $0.transferToken,
          accountScope: $0.accountScope,
          songId: $0.songId,
          scopes: $0.scopes,
          songJSON: $0.songJSON,
          audioURL: $0.audioURL,
          coverURL: $0.coverURL,
          lyricsURL: $0.lyricsURL,
          refreshURL: $0.refreshURL,
          audioPath: $0.audioPath,
          coverPath: $0.coverPath,
          lyricsPath: $0.lyricsPath,
          priority: $0.priority
        )
      }
      try BackgroundDownloadCoordinator.shared.enqueue(jobs)
    }

    AsyncFunction("cancel") { (records: [BackgroundDownloadReferenceRecord]) in
      try BackgroundDownloadCoordinator.shared.cancel(
        records.map {
          BackgroundDownloadReference(
            key: $0.key,
            transferToken: $0.transferToken
          )
        }
      )
    }

    AsyncFunction("cancelAccount") { (accountScope: String) in
      try BackgroundDownloadCoordinator.shared.cancelAccount(accountScope)
    }

    AsyncFunction("cancelAll") {
      try BackgroundDownloadCoordinator.shared.cancelAll()
    }

    AsyncFunction("snapshot") { (accountScope: String?) -> [[String: Any]] in
      BackgroundDownloadCoordinator.shared.snapshot(accountScope: accountScope)
    }

    AsyncFunction("acknowledge") {
      (records: [BackgroundDownloadAcknowledgementRecord]) in
      try BackgroundDownloadCoordinator.shared.acknowledge(
        records.map {
          BackgroundDownloadAcknowledgement(
            key: $0.key,
            transferToken: $0.transferToken,
            revision: $0.revision
          )
        }
      )
    }

    AsyncFunction("setActiveAccount") { (accountScope: String) in
      try BackgroundDownloadCoordinator.shared.setActiveAccount(accountScope)
    }
  }
}
