const path = require("path");
const fs = require("fs");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts = [...config.resolver.assetExts, "wasm"];
const sharedRoot = path.resolve(__dirname, "../packages/shared");
config.watchFolders = [...(config.watchFolders ?? []), sharedRoot];
config.resolver.useWatchman = false;
// Expo's export optimization discards external watch folders. Keep the shared
// workspace package in Metro's file map so Release embeds can hash its sources.
config.resolver.unstable_onDemandFilesystem = false;
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  // Point Metro at the package root so its explicit subpath exports resolve.
  // Mapping directly to src bypasses package.json and fails in Release embeds.
  "@spotify/shared": sharedRoot,
};
const sharedPrefix = "@spotify/shared/";
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(sharedPrefix)) {
    const subpath = moduleName.slice(sharedPrefix.length);
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(subpath)) {
      throw new Error(`Invalid @spotify/shared subpath: ${moduleName}`);
    }
    const filePath = path.join(sharedRoot, "src", `${subpath}.ts`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing @spotify/shared export: ${moduleName}`);
    }
    return { filePath, type: "sourceFile" };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: "./global.css" });
