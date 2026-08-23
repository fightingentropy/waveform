package expo.modules.backgrounddownloads

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class BackgroundDownloadRequestRecord : Record {
  @Field var key: String = ""
  @Field var transferToken: String = ""
  @Field var accountScope: String = ""
  @Field var songId: String = ""
  @Field var scopes: List<String> = emptyList()
  @Field var songJSON: String = ""
  @Field var audioURL: String = ""
  @Field var coverURL: String? = null
  @Field var lyricsURL: String? = null
  @Field var refreshURL: String = ""
  @Field var audioPath: String = ""
  @Field var coverPath: String? = null
  @Field var lyricsPath: String? = null
  @Field var priority: Double = 0.25
}

class BackgroundDownloadReferenceRecord : Record {
  @Field var key: String = ""
  @Field var transferToken: String = ""
}

class BackgroundDownloadAcknowledgementRecord : Record {
  @Field var key: String = ""
  @Field var transferToken: String = ""
  @Field var revision: Long = 0
}
