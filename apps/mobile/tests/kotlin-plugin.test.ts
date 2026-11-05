import { describe, expect, it } from "vitest";
import { pinKotlinPlugin } from "../plugins/withKotlinGradlePlugin.js";

const generated = `buildscript {
  dependencies {
    classpath('com.android.tools.build:gradle')
    classpath('com.facebook.react:react-native-gradle-plugin')
    classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')
  }
}`;

describe("withKotlinGradlePlugin", () => {
  it("pins the Kotlin Gradle plugin version", () => {
    const out = pinKotlinPlugin(generated, "2.3.20");
    expect(out).toContain("classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:2.3.20')");
    expect(out).toContain("classpath('com.facebook.react:react-native-gradle-plugin')");
  });
  it("is idempotent and replaces an existing version", () => {
    const once = pinKotlinPlugin(generated, "2.3.20");
    expect(pinKotlinPlugin(once, "2.3.20")).toBe(once);
  });
  it("fails loudly when the classpath line is missing", () => {
    expect(() => pinKotlinPlugin("buildscript {}", "2.3.20")).toThrow();
  });
});
