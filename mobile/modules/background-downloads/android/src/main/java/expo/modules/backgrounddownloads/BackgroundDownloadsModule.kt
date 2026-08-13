package expo.modules.backgrounddownloads

import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BackgroundDownloadsModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private var coordinator: BackgroundDownloadCoordinator? = null

  override fun definition() = ModuleDefinition {
    Name("BackgroundDownloads")

    Events("stateChanged")

    OnCreate {
      val context = appContext.reactContext?.applicationContext
        ?: return@OnCreate
      val instance = BackgroundDownloadCoordinator.get(context)
      coordinator = instance
      instance.listener = { payload ->
        mainHandler.post {
          sendEvent("stateChanged", payload)
        }
      }
      instance.restoreAndSchedule()
    }

    OnDestroy {
      coordinator?.listener = null
      coordinator = null
    }

    AsyncFunction("enqueue") { records: Array<BackgroundDownloadRequestRecord> ->
      requireCoordinator().enqueue(records.toList())
    }

    AsyncFunction("cancel") { records: Array<BackgroundDownloadReferenceRecord> ->
      requireCoordinator().cancel(records.toList())
    }

    AsyncFunction("cancelAccount") { accountScope: String ->
      requireCoordinator().cancelAccount(accountScope)
    }

    AsyncFunction("cancelAll") {
      requireCoordinator().cancelAll()
    }

    AsyncFunction("snapshot") { accountScope: String? ->
      requireCoordinator().snapshot(accountScope)
    }

    AsyncFunction("acknowledge") { records: Array<BackgroundDownloadAcknowledgementRecord> ->
      requireCoordinator().acknowledge(records.toList())
    }

    AsyncFunction("setActiveAccount") { accountScope: String ->
      requireCoordinator().setActiveAccount(accountScope)
    }
  }

  private fun requireCoordinator(): BackgroundDownloadCoordinator {
    val existing = coordinator
    if (existing != null) return existing
    val context = appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("Background downloads are unavailable")
    return BackgroundDownloadCoordinator.get(context).also { coordinator = it }
  }
}
