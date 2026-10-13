// The app imports a few pure helpers straight from packages/shared/src (src/lib/shared.ts); Metro
// only bundles files under its watch folders, so that one folder is added. Nothing else changes.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, "../../packages/shared/src")];

module.exports = config;
