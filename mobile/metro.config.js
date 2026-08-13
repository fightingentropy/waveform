const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = [...config.resolver.assetExts, "wasm"];
const sharedRoot = path.resolve(__dirname, "../packages/shared");
config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@spotify/shared": path.resolve(sharedRoot, "src"),
};

module.exports = withNativeWind(config, { input: "./global.css" });
