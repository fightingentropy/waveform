const { withPodfile, withPodfileProperties } = require("expo/config-plugins");

const MINIMUM_IOS_VERSION = "16.4";
const BEGIN_MARKER = "    # @generated begin spotify-xcode27-deployment-target";
const END_MARKER = "    # @generated end spotify-xcode27-deployment-target";

function deploymentTargetBlock() {
  return `${BEGIN_MARKER}
    # Xcode 27 rejects Pod targets below iOS 15. Keep every generated Pod at
    # least the app/Expo deployment target while preserving any higher minimum.
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |build_config|
        current = build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current.nil? || current.to_f < ${MINIMUM_IOS_VERSION}
          build_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${MINIMUM_IOS_VERSION}'
        end
      end
    end
${END_MARKER}`;
}

// mobile/ios is generated and git-ignored, so this config plugin is the durable
// source of the Xcode 27 CocoaPods fix on every prebuild.
module.exports = function withXcode27DeploymentTarget(config) {
  const withPrecompiledNativeDependencies = withPodfileProperties(config, (cfg) => {
    // SDK 57 defaults to precompiled React Native and Expo XCFrameworks. An old
    // generated property forced a slow source build, which also sends Expo's JSI
    // Swift through an unsupported Xcode 27 compiler path.
    cfg.modResults["ios.buildReactNativeFromSource"] = "false";
    return cfg;
  });

  return withPodfile(withPrecompiledNativeDependencies, (cfg) => {
    const contents = cfg.modResults.contents;
    const existingStart = contents.indexOf(BEGIN_MARKER);
    const existingEnd = contents.indexOf(END_MARKER);
    const block = deploymentTargetBlock();

    if (existingStart >= 0 && existingEnd > existingStart) {
      cfg.modResults.contents =
        contents.slice(0, existingStart) +
        block +
        contents.slice(existingEnd + END_MARKER.length);
      return cfg;
    }

    const postInstallEnd = "\n  end\nend";
    const insertionPoint = contents.lastIndexOf(postInstallEnd);
    if (insertionPoint < 0) {
      throw new Error("Could not locate the Expo Podfile post_install block");
    }
    cfg.modResults.contents =
      contents.slice(0, insertionPoint) +
      `\n${block}` +
      contents.slice(insertionPoint);
    return cfg;
  });
};
