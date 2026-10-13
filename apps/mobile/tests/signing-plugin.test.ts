import { describe, expect, it } from "vitest";
import { patchBuildGradle } from "../plugins/withReleaseSigning.js";

const generated = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }`;

describe("withReleaseSigning", () => {
  it("adds a release signing config from the environment and leaves debug alone", () => {
    const out = patchBuildGradle(generated);
    expect(out).toContain('storeFile file(ksPath)');
    expect(out.match(/signingConfig signingConfigs\.debug/g)).toHaveLength(1); // the debug build type only
    expect(out).toContain('signingConfig System.getenv("TALORYS_KEYSTORE_PATH") ? signingConfigs.release : signingConfigs.debug');
    expect(patchBuildGradle(out)).toBe(out); // idempotent
  });
});
