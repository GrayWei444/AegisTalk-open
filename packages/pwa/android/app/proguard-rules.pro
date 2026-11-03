# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ============================================
# 官方版才有的類別（NetworkShield／Rust JNI、守護）的規則在 proguard-official.pro（只給 flavour official；開源第 5d 步）
# ============================================

# ============================================
# Capacitor Core + Plugins — R8 混淆導致 NPE
# ============================================
# Capacitor Plugin 使用 @PermissionCallback 和 @CapacitorPlugin annotations
# R8 會移除這些 annotation，導致 getPermissionStates() NPE
-keep class com.getcapacitor.** { *; }
-keep class com.capacitorjs.plugins.** { *; }

# ============================================
# Firebase Cloud Messaging
# ============================================
-keep class com.aegisrd.talk.AegisFCMService { *; }
-keep class com.google.firebase.** { *; }
-dontwarn com.google.firebase.ktx.Firebase
