// Config plugin: sign release builds with a keystore named by environment variables
// (TALORYS_KEYSTORE_PATH, TALORYS_KEYSTORE_PASSWORD, TALORYS_KEY_ALIAS, TALORYS_KEY_PASSWORD).
// Nothing about the keystore lives in git; without the variables the release build keeps
// the debug signing config, exactly as `expo prebuild` generates it.
const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING = `
        release {
            def ksPath = System.getenv("TALORYS_KEYSTORE_PATH")
            if (ksPath) {
                storeFile file(ksPath)
                storePassword System.getenv("TALORYS_KEYSTORE_PASSWORD")
                keyAlias System.getenv("TALORYS_KEY_ALIAS") ?: "talorys"
                keyPassword System.getenv("TALORYS_KEY_PASSWORD") ?: System.getenv("TALORYS_KEYSTORE_PASSWORD")
            }
        }
`;

const RELEASE_LINE = "// see https://reactnative.dev/docs/signed-apk-android.\n            signingConfig signingConfigs.debug";
const RELEASE_PATCHED = '// see https://reactnative.dev/docs/signed-apk-android.\n            signingConfig System.getenv("TALORYS_KEYSTORE_PATH") ? signingConfigs.release : signingConfigs.debug';

function patchBuildGradle(contents) {
  if (contents.includes("TALORYS_KEYSTORE_PATH")) return contents;
  let s = contents.replace(/(signingConfigs \{[\s\S]*?debug \{[\s\S]*?\n\s*\}\n)/, (m) => m + SIGNING);
  if (!s.includes(RELEASE_LINE)) throw new Error("withReleaseSigning: the release signingConfig line was not where expected in app/build.gradle");
  s = s.replace(RELEASE_LINE, RELEASE_PATCHED);
  return s;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    c.modResults.contents = patchBuildGradle(c.modResults.contents);
    return c;
  });
};
module.exports.patchBuildGradle = patchBuildGradle;
