const { withProjectBuildGradle } = require("expo/config-plugins");

/**
 * Pins the Kotlin Gradle plugin in android/build.gradle to the app's Kotlin version.
 * expo-build-properties' kotlinVersion only moves the stdlib; the plugin classpath is unversioned
 * and resolves to React Native's catalog (2.1.20), which cannot read Kotlin 2.3 metadata
 * (litertlm-android 0.19.0 needs >= 2.3). See docs/local-models.md.
 */
function pinKotlinPlugin(contents, version) {
  const re = /classpath\(\s*['"]org\.jetbrains\.kotlin:kotlin-gradle-plugin(?::[^'"]*)?['"]\s*\)/;
  if (!re.test(contents)) throw new Error("withKotlinGradlePlugin: kotlin-gradle-plugin classpath not found in android/build.gradle");
  return contents.replace(re, `classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:${version}')`);
}

const withKotlinGradlePlugin = (config, props = {}) =>
  withProjectBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== "groovy") throw new Error("withKotlinGradlePlugin: expected a Groovy build.gradle");
    cfg.modResults.contents = pinKotlinPlugin(cfg.modResults.contents, props.version ?? "2.3.20");
    return cfg;
  });

module.exports = withKotlinGradlePlugin;
module.exports.pinKotlinPlugin = pinKotlinPlugin;
