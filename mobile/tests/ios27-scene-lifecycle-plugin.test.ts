import { describe, expect, test } from "bun:test";

// The config plugin is intentionally CommonJS because Expo loads it with require().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applySceneLifecycleToAppDelegate } = require("../plugins/withIOS27SceneLifecycle");

const expoAppDelegate = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {}
`;

describe("iOS 27 scene lifecycle config plugin", () => {
  test("defers iOS React startup until scene connection options are available", () => {
    const generated = applySceneLifecycleToAppDelegate(expoAppDelegate);

    expect(generated).toContain("#if os(iOS)");
    expect(generated).toContain(
      "launchOptions: reactNativeLaunchOptions(from: connectionOptions)",
    );
    expect(generated).toContain("UIApplicationLaunchOptionsURLKey");
    expect(generated).toContain(
      "UIApplicationLaunchOptionsUserActivityDictionaryKey",
    );
    expect(generated).toContain(
      "forwardLinkingConnectionOptions(connectionOptions, to: appDelegate)",
    );
    expect(
      generated.indexOf(
        "forwardLinkingConnectionOptions(connectionOptions, to: appDelegate)",
      ),
    ).toBeLessThan(
      generated.indexOf(
        "launchOptions: reactNativeLaunchOptions(from: connectionOptions)",
      ),
    );
    expect(generated.indexOf("spotify-ios27-scene-startup")).toBeGreaterThan(-1);
    expect(generated.indexOf("spotify-ios27-scene-configuration")).toBeGreaterThan(
      generated.indexOf("spotify-ios27-scene-startup"),
    );
  });

  test("is idempotent", () => {
    const generated = applySceneLifecycleToAppDelegate(expoAppDelegate);
    const regenerated = applySceneLifecycleToAppDelegate(generated);

    expect(regenerated).toBe(generated);
    expect(
      regenerated.match(/@generated begin spotify-ios27-scene-delegate/g),
    ).toHaveLength(1);
  });

  test("fails closed when Expo's startup template changes", () => {
    expect(() =>
      applySceneLifecycleToAppDelegate(
        expoAppDelegate.replace(
          "window = UIWindow(frame: UIScreen.main.bounds)",
          "window = makeWindow()",
        ),
      ),
    ).toThrow("Could not locate Expo's React Native startup block");
  });
});
