import { describe, expect, test } from "bun:test";

// Expo config plugins are CommonJS because prebuild loads them with require().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyBackgroundDownloadsToAppDelegate } = require("../plugins/withBackgroundDownloads");

const expoAppDelegate = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    return super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {}
`;

describe("background downloads AppDelegate plugin", () => {
  test("intercepts only the stable native session and delegates every other identifier", () => {
    const generated =
      applyBackgroundDownloadsToAppDelegate(expoAppDelegate);

    expect(generated).toContain("internal import BackgroundDownloads");
    expect(generated).toContain(
      "BackgroundDownloadCoordinator.handles(sessionIdentifier: identifier)",
    );
    expect(generated).toContain(
      "BackgroundDownloadCoordinator.shared.handleEvents(",
    );
    expect(generated).toContain(
      "super.application(\n      application,\n      handleEventsForBackgroundURLSession: identifier",
    );
  });

  test("is idempotent", () => {
    const generated =
      applyBackgroundDownloadsToAppDelegate(expoAppDelegate);
    const regenerated =
      applyBackgroundDownloadsToAppDelegate(generated);

    expect(regenerated).toBe(generated);
    expect(
      regenerated.match(
        /@generated begin spotify-background-download-session/g,
      ),
    ).toHaveLength(1);
    expect(
      regenerated.match(/internal import BackgroundDownloads/g),
    ).toHaveLength(1);
  });

  test("fails closed when Expo changes the AppDelegate insertion point", () => {
    expect(() =>
      applyBackgroundDownloadsToAppDelegate(
        expoAppDelegate.replace("  // Linking API", "  // Routing"),
      ),
    ).toThrow("Could not locate AppDelegate Linking API insertion point");
  });
});
