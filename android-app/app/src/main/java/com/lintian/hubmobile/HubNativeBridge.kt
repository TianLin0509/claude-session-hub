package com.lintian.hubmobile

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * JS Bridge：PWA 可通过 `window.HubNative.xxx()` 调用 wrapper 原生能力。
 * 这是 wrapper 的**长期投资点**——任何未来想用的原生 API，加方法即可，
 * PWA 端 JS 调用，不需要重新发版 wrapper（前提是方法已经预埋）。
 *
 * 现已暴露：
 *   - 应用版本、自检更新、配置面板
 *   - 系统浏览器打开、系统分享
 *   - 剪贴板读写、振动、Toast
 *   - 文件保存（base64 写盘）
 *   - 强制重载、清缓存
 *   - 设备/系统信息
 */
class HubNativeBridge(
    private val activity: Activity,
    private val webView: WebView,
    private val updater: WrapperUpdater,
    private val remoteConfig: RemoteConfigManager,
    private val prefs: HubPrefs,
) {
    @JavascriptInterface
    fun getAppVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getAppVersionCode(): Int = BuildConfig.VERSION_CODE

    @JavascriptInterface
    fun getNativeInfo(): String {
        val json = JSONObject().apply {
            put("versionName", BuildConfig.VERSION_NAME)
            put("versionCode", BuildConfig.VERSION_CODE)
            put("packageName", activity.packageName)
            put("manufacturer", Build.MANUFACTURER)
            put("model", Build.MODEL)
            put("sdk", Build.VERSION.SDK_INT)
            put("androidRelease", Build.VERSION.RELEASE)
            put("pwaUrl", prefs.pwaUrl)
            put("remoteConfigUrl", prefs.remoteConfigUrl)
            put("cacheEpoch", prefs.cacheEpoch)
            put("forceNoCache", prefs.forceNoCache)
        }
        return json.toString()
    }

    @JavascriptInterface
    fun checkUpdate() {
        runOnUi { updater.checkUpdate(silent = false) }
    }

    @JavascriptInterface
    fun refreshRemoteConfig() {
        remoteConfig.fetchAndApply(silent = false, force = true)
    }

    @JavascriptInterface
    fun openConfigPanel() {
        runOnUi {
            activity.startActivity(Intent(activity, ConfigActivity::class.java))
        }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        runOnUi {
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                activity.startActivity(intent)
            } catch (e: Exception) {
                toast("打开链接失败: ${e.message}")
            }
        }
    }

    @JavascriptInterface
    fun shareText(text: String, title: String = "分享") {
        runOnUi {
            try {
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                    putExtra(Intent.EXTRA_TITLE, title)
                }
                activity.startActivity(Intent.createChooser(intent, title))
            } catch (e: Exception) {
                toast("分享失败: ${e.message}")
            }
        }
    }

    @JavascriptInterface
    fun copyToClipboard(text: String, label: String = "Hub") {
        runOnUi {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText(label, text))
            toast("已复制")
        }
    }

    @JavascriptInterface
    fun readClipboard(): String {
        return try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip ?: return ""
            if (clip.itemCount == 0) "" else clip.getItemAt(0).coerceToText(activity).toString()
        } catch (e: Exception) { "" }
    }

    @JavascriptInterface
    fun vibrate(ms: Long) {
        runOnUi {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val vm = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
                    vm.defaultVibrator.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    val v = activity.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
                    } else {
                        @Suppress("DEPRECATION") v.vibrate(ms)
                    }
                }
            } catch (e: Exception) { Log.w(TAG, "vibrate failed: ${e.message}") }
        }
    }

    @JavascriptInterface
    fun showToast(text: String) {
        runOnUi { Toast.makeText(activity, text, Toast.LENGTH_SHORT).show() }
    }

    @JavascriptInterface
    fun forceReload() {
        runOnUi {
            webView.clearCache(false)
            webView.reload()
        }
    }

    @JavascriptInterface
    fun softReload() {
        runOnUi {
            webView.clearCache(false)
            webView.loadUrl(RemoteConfigManager.buildPwaUrl(prefs))
        }
    }

    @JavascriptInterface
    fun hardReset() {
        runOnUi {
            webView.clearCache(true)
            webView.clearHistory()
            webView.clearFormData()
            android.webkit.WebStorage.getInstance().deleteAllData()
            android.webkit.CookieManager.getInstance().removeAllCookies(null)
            webView.loadUrl(RemoteConfigManager.buildPwaUrl(prefs))
            toast("已清除全部缓存 + 重新加载")
        }
    }

    @JavascriptInterface
    fun setPwaUrl(url: String) {
        prefs.pwaUrl = url
        runOnUi {
            webView.loadUrl(RemoteConfigManager.buildPwaUrl(prefs))
            toast("已切换到 $url")
        }
    }

    @JavascriptInterface
    fun setRemoteConfigUrl(url: String) {
        prefs.remoteConfigUrl = url
        refreshRemoteConfig()
    }

    @JavascriptInterface
    fun bumpCacheEpoch(epoch: String) {
        prefs.cacheEpoch = epoch
        softReload()
    }

    /**
     * 保存 base64 数据到设备 Downloads 目录（artifact 离线保存用）
     * 不申请额外权限——写到 app 自己的 external files 目录，免运行时权限
     */
    @JavascriptInterface
    fun saveFile(fileName: String, base64: String, mimeType: String = "application/octet-stream"): String {
        return try {
            val safeName = fileName.replace(Regex("[\\\\/:*?\"<>|]"), "_")
            val dir = File(activity.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS), "hub-artifacts")
            if (!dir.exists()) dir.mkdirs()
            val file = File(dir, safeName)
            val data = Base64.decode(base64, Base64.DEFAULT)
            FileOutputStream(file).use { it.write(data) }
            toast("已保存到 $safeName")
            file.absolutePath
        } catch (e: Exception) {
            toast("保存失败: ${e.message}")
            ""
        }
    }

    private fun runOnUi(block: () -> Unit) = activity.runOnUiThread(block)
    private fun toast(msg: String) = runOnUi { Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show() }

    companion object {
        const val NAME = "HubNative"
        private const val TAG = "HubNativeBridge"
    }
}
