const { withAppDelegate } = require("expo/config-plugins");

const IMPORT_LINE = "internal import BackgroundDownloads";
const HANDLER_BEGIN =
  "  // @generated begin spotify-background-download-session";
const HANDLER_END =
  "  // @generated end spotify-background-download-session";

const handlerBlock = `${HANDLER_BEGIN}
  public override func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    // Expo forwards every identifier to every app-delegate subscriber. Its file
    // system subscriber retains unknown identifiers, so our stable session must
    // bypass that fan-out or UIKit's completion handler can remain unresolved.
    if BackgroundDownloadCoordinator.handles(sessionIdentifier: identifier) {
      BackgroundDownloadCoordinator.shared.handleEvents(
        forBackgroundURLSession: identifier,
        completionHandler: completionHandler)
      return
    }
    super.application(
      application,
      handleEventsForBackgroundURLSession: identifier,
      completionHandler: completionHandler)
  }
${HANDLER_END}`;

function upsertImport(contents) {
  if (contents.includes(IMPORT_LINE)) return contents;
  const mainIndex = contents.indexOf("@main");
  if (mainIndex < 0) {
    throw new Error(
      "Could not locate @main while installing background downloads",
    );
  }
  return (
    contents.slice(0, mainIndex) +
    `${IMPORT_LINE}\n\n` +
    contents.slice(mainIndex)
  );
}

function upsertHandler(contents) {
  const start = contents.indexOf(HANDLER_BEGIN);
  const finish = contents.indexOf(HANDLER_END);
  if (start >= 0 && finish > start) {
    return (
      contents.slice(0, start) +
      handlerBlock +
      contents.slice(finish + HANDLER_END.length)
    );
  }

  const linkingIndex = contents.indexOf("  // Linking API");
  if (linkingIndex < 0) {
    throw new Error(
      "Could not locate AppDelegate Linking API insertion point for background downloads",
    );
  }
  return (
    contents.slice(0, linkingIndex) +
    `${handlerBlock}\n\n` +
    contents.slice(linkingIndex)
  );
}

function applyBackgroundDownloadsToAppDelegate(contents) {
  return upsertHandler(upsertImport(contents));
}

module.exports = function withBackgroundDownloads(config) {
  return withAppDelegate(config, (mod) => {
    if (mod.modResults.language !== "swift") {
      throw new Error("Background downloads require a Swift AppDelegate");
    }
    mod.modResults.contents = applyBackgroundDownloadsToAppDelegate(
      mod.modResults.contents,
    );
    return mod;
  });
};

module.exports.applyBackgroundDownloadsToAppDelegate =
  applyBackgroundDownloadsToAppDelegate;
