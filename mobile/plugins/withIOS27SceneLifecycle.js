const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const CONFIG_BEGIN = "  // @generated begin spotify-ios27-scene-configuration";
const CONFIG_END = "  // @generated end spotify-ios27-scene-configuration";
const STARTUP_BEGIN = "    // @generated begin spotify-ios27-scene-startup";
const STARTUP_END = "    // @generated end spotify-ios27-scene-startup";
const DELEGATE_BEGIN = "// @generated begin spotify-ios27-scene-delegate";
const DELEGATE_END = "// @generated end spotify-ios27-scene-delegate";

const expoStartupPattern =
  /#if os\(iOS\) \|\| os\(tvOS\)\r?\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\r?\n\s*factory\.startReactNative\(\r?\n\s*withModuleName: "main",\r?\n\s*in: window,\r?\n\s*launchOptions: launchOptions\)\r?\n#endif/;

const sceneAwareStartup = `${STARTUP_BEGIN}
#if os(iOS)
    // UIKit supplies scene launch URLs and user activities later, in
    // scene(_:willConnectTo:options:). Start React Native there so Linking's
    // initial URL is populated instead of racing an early URL notification.
#elseif os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif
${STARTUP_END}`;

const sceneConfiguration = `${CONFIG_BEGIN}
  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
${CONFIG_END}`;

const sceneDelegate = `${DELEGATE_BEGIN}
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  private var appDelegate: AppDelegate? {
    UIApplication.shared.delegate as? AppDelegate
  }

  private func reactNativeLaunchOptions(
    from connectionOptions: UIScene.ConnectionOptions
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]

    if let context = connectionOptions.urlContexts.first {
      // React Native still reads the legacy launch-options keys internally.
      // Constructing the typed keys from their stable raw values avoids using
      // APIs deprecated by the iOS 27 SDK at this scene-lifecycle boundary.
      launchOptions[
        UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")
      ] = context.url

      if let sourceApplication =
        connectionOptions.sourceApplication ?? context.options.sourceApplication {
        launchOptions[
          UIApplication.LaunchOptionsKey(
            rawValue: "UIApplicationLaunchOptionsSourceApplicationKey")
        ] = sourceApplication
      }
    }

    if let userActivity = connectionOptions.userActivities.first(where: {
      $0.activityType == NSUserActivityTypeBrowsingWeb && $0.webpageURL != nil
    }) {
      launchOptions[
        UIApplication.LaunchOptionsKey(
          rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")
      ] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": userActivity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": userActivity,
      ]
    }

    return launchOptions.isEmpty ? nil : launchOptions
  }

  private func openURLOptions(
    from context: UIOpenURLContext
  ) -> [UIApplication.OpenURLOptionsKey: Any] {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [
      .openInPlace: context.options.openInPlace
    ]
    if let sourceApplication = context.options.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = context.options.annotation {
      options[.annotation] = annotation
    }
    return options
  }

  private func forwardLinkingConnectionOptions(
    _ connectionOptions: UIScene.ConnectionOptions,
    to appDelegate: AppDelegate
  ) {
    // Expo Router reads ExpoLinkingRegistry synchronously on iOS rather than
    // React Native's asynchronous Linking.getInitialURL(). Forward the scene
    // request before starting React Native so ExpoLinking's app-delegate
    // subscriber records the URL in that registry.
    for context in connectionOptions.urlContexts {
      _ = appDelegate.application(
        UIApplication.shared,
        open: context.url,
        options: openURLOptions(from: context))
    }
    for userActivity in connectionOptions.userActivities where
      userActivity.activityType == NSUserActivityTypeBrowsingWeb {
      _ = appDelegate.application(
        UIApplication.shared,
        continue: userActivity,
        restorationHandler: { _ in })
    }
  }

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene, let appDelegate else {
      return
    }

    forwardLinkingConnectionOptions(connectionOptions, to: appDelegate)

    if let existingWindow = appDelegate.window {
      existingWindow.windowScene = windowScene
      window = existingWindow
      if existingWindow.rootViewController == nil,
        let factory = appDelegate.reactNativeFactory {
        factory.startReactNative(
          withModuleName: "main",
          in: existingWindow,
          launchOptions: reactNativeLaunchOptions(from: connectionOptions))
      }
      existingWindow.makeKeyAndVisible()
      return
    }

    guard let factory = appDelegate.reactNativeFactory else {
      return
    }
    let sceneWindow = UIWindow(windowScene: windowScene)
    window = sceneWindow
    appDelegate.window = sceneWindow
    factory.startReactNative(
      withModuleName: "main",
      in: sceneWindow,
      launchOptions: reactNativeLaunchOptions(from: connectionOptions))
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    appDelegate?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    appDelegate?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    appDelegate?.applicationDidEnterBackground(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    appDelegate?.applicationWillEnterForeground(UIApplication.shared)
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate else {
      return
    }
    for context in URLContexts {
      _ = appDelegate.application(
        UIApplication.shared,
        open: context.url,
        options: openURLOptions(from: context))
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate else {
      return
    }
    _ = appDelegate.application(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: { _ in })
  }
}
${DELEGATE_END}`;

function upsertBlock(contents, begin, end, block, insertionPoint) {
  const start = contents.indexOf(begin);
  const finish = contents.indexOf(end);
  if (start >= 0 && finish > start) {
    return (
      contents.slice(0, start) +
      block +
      contents.slice(finish + end.length)
    );
  }
  if (insertionPoint < 0) {
    throw new Error("Could not locate the insertion point for the iOS 27 scene lifecycle");
  }
  return (
    contents.slice(0, insertionPoint) +
    block +
    "\n\n" +
    contents.slice(insertionPoint)
  );
}

function upsertSceneAwareStartup(contents) {
  if (contents.includes(STARTUP_BEGIN)) {
    return upsertBlock(
      contents,
      STARTUP_BEGIN,
      STARTUP_END,
      sceneAwareStartup,
      -1,
    );
  }

  const matches = contents.match(expoStartupPattern);
  if (!matches) {
    throw new Error(
      "Could not locate Expo's React Native startup block for the iOS 27 scene lifecycle",
    );
  }
  return contents.replace(expoStartupPattern, sceneAwareStartup);
}

function applySceneLifecycleToAppDelegate(contents) {
  let result = upsertSceneAwareStartup(contents);
  result = upsertBlock(
    result,
    CONFIG_BEGIN,
    CONFIG_END,
    sceneConfiguration,
    result.indexOf("  // Linking API"),
  );
  result = upsertBlock(
    result,
    DELEGATE_BEGIN,
    DELEGATE_END,
    sceneDelegate,
    result.length,
  );
  return result;
}

module.exports = function withIOS27SceneLifecycle(config) {
  const withSceneManifest = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return cfg;
  });

  return withAppDelegate(withSceneManifest, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error("The iOS 27 scene lifecycle plugin requires a Swift AppDelegate");
    }

    cfg.modResults.contents = applySceneLifecycleToAppDelegate(
      cfg.modResults.contents,
    );
    return cfg;
  });
};

module.exports.applySceneLifecycleToAppDelegate =
  applySceneLifecycleToAppDelegate;
