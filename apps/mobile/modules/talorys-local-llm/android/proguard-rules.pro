# LiteRT-LM: JNI entry points and reflection (gson, kotlin-reflect) — keep the whole API.
-keep class com.google.ai.edge.litertlm.** { *; }
-dontwarn com.google.ai.edge.litertlm.**
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod

# Called by reflection from the keyboard's CompanionService (LocalBridgeHook).
-keep class com.talorys.localllm.bridge.BridgeKeeper { *; }

# OkHttp
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Tink (security-crypto)
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
