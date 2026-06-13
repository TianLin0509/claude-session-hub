import org.gradle.api.tasks.compile.JavaCompile
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("keystore.properties")
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}
fun signingProp(name: String): String? =
    keystoreProperties.getProperty(name) ?: keystoreProperties.getProperty("﻿$name")

android {
    namespace = "com.lintian.hubmobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.lintian.hubmobile"
        minSdk = 23
        targetSdk = 34
        versionCode = 4
        versionName = "0.4.0"
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        create("releaseLocal") {
            val storeFilePath = signingProp("storeFile")
            if (!storeFilePath.isNullOrBlank()) {
                storeFile = rootProject.file(storeFilePath)
                storePassword = signingProp("storePassword")
                keyAlias = signingProp("keyAlias")
                keyPassword = signingProp("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isDebuggable = true
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("releaseLocal")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}
