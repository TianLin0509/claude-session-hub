import org.gradle.api.tasks.compile.JavaCompile
import java.util.Properties

plugins {
    id("com.android.application")
}

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("keystore.properties")
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}
fun signingProp(name: String): String? =
    keystoreProperties.getProperty(name) ?: keystoreProperties.getProperty("\uFEFF$name")

android {
    namespace = "com.lintian.codexhubmobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.lintian.codexhubmobile"
        minSdk = 23
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
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
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("releaseLocal")
        }
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core:1.13.1")
}

tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}
