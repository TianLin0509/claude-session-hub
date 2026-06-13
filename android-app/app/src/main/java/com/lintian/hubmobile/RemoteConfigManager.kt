package com.lintian.hubmobile

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Remote wrapper config keeps the APK as a long-lived shell.
 *
 * VPS can publish /mobile/wrapper-config.json to change:
 * - pwaUrl
 * - updateCheckUrl
 * - cacheEpoch, to force a WebView HTTP cache refresh while preserving PWA localStorage
 * - forceNoCache, for emergency rollout windows
 */
class RemoteConfigManager(
    private val context: Context,
    private val prefs: HubPrefs,
    private val webViewProvider: () -> WebView?,
) {
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .connectTimeout(6, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .build()

    fun fetchAndApply(silent: Boolean = true, force: Boolean = false) {
        val sinceLast = System.currentTimeMillis() - prefs.lastRemoteConfigCheckMs
        if (!force && sinceLast in 0..MIN_CHECK_INTERVAL_MS) return
        prefs.lastRemoteConfigCheckMs = System.currentTimeMillis()

        val configUrl = prefs.remoteConfigUrl
        if (!isHttpUrl(configUrl)) return

        Thread {
            try {
                val resp = client.newCall(Request.Builder().url(configUrl).build()).execute()
                if (!resp.isSuccessful) {
                    Log.w(TAG, "remote config HTTP ${resp.code}")
                    resp.close()
                    return@Thread
                }
                val body = resp.body?.string() ?: ""
                resp.close()
                if (body.isBlank()) return@Thread
                applyConfig(JSONObject(body), silent)
            } catch (e: Exception) {
                Log.w(TAG, "remote config failed: ${e.message}")
            }
        }.start()
    }

    private fun applyConfig(obj: JSONObject, silent: Boolean) {
        val oldUrl = prefs.pwaUrl
        val oldEpoch = prefs.cacheEpoch
        val newPwaUrl = obj.optString("pwaUrl", "").trim()
        val newUpdateUrl = obj.optString("updateCheckUrl", "").trim()
        val newRemoteConfigUrl = obj.optString("remoteConfigUrl", "").trim()
        val newEpoch = obj.optString("cacheEpoch", oldEpoch).trim().ifBlank { oldEpoch }
        val forceNoCache = obj.optBoolean("forceNoCache", prefs.forceNoCache)
        val forceReload = obj.optBoolean("forceReload", false)

        if (isHttpUrl(newPwaUrl)) prefs.pwaUrl = newPwaUrl
        if (isHttpUrl(newUpdateUrl)) prefs.updateCheckUrl = newUpdateUrl
        if (isHttpUrl(newRemoteConfigUrl)) prefs.remoteConfigUrl = newRemoteConfigUrl
        prefs.forceNoCache = forceNoCache
        prefs.cacheEpoch = newEpoch

        val urlChanged = prefs.pwaUrl != oldUrl
        val epochChanged = prefs.cacheEpoch != oldEpoch
        val shouldReload = urlChanged || epochChanged || forceReload
        if (!shouldReload) return

        main.post {
            val wv = webViewProvider() ?: return@post
            if (forceNoCache) wv.settings.cacheMode = WebSettings.LOAD_NO_CACHE
            else wv.settings.cacheMode = WebSettings.LOAD_DEFAULT
            if (epochChanged) {
                wv.clearCache(true)
            }
            wv.loadUrl(buildPwaUrl(prefs))
            if (!silent) {
                android.widget.Toast.makeText(context, "AI Hub PWA config applied", android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }

    fun injectNativeReady() {
        val wv = webViewProvider() ?: return
        val info = JSONObject().apply {
            put("wrapperVersion", BuildConfig.VERSION_NAME)
            put("wrapperVersionCode", BuildConfig.VERSION_CODE)
            put("pwaUrl", prefs.pwaUrl)
            put("cacheEpoch", prefs.cacheEpoch)
            put("remoteConfigUrl", prefs.remoteConfigUrl)
            put("forceNoCache", prefs.forceNoCache)
        }.toString()
        val js = """
            (function(){
              try {
                window.AIHubNativeInfo = $info;
                if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
                  navigator.serviceWorker.getRegistrations().then(function(regs){
                    regs.forEach(function(r){ try { r.update(); } catch(e) {} });
                  }).catch(function(){});
                }
                window.dispatchEvent(new CustomEvent('hub:native-ready', { detail: window.AIHubNativeInfo }));
              } catch(e) {}
            })();
        """.trimIndent()
        wv.evaluateJavascript(js, null)
    }

    companion object {
        private const val TAG = "RemoteConfigManager"
        private const val MIN_CHECK_INTERVAL_MS = 30_000L

        fun buildPwaUrl(prefs: HubPrefs): String {
            val base = prefs.pwaUrl
            return try {
                val uri = Uri.parse(base)
                uri.buildUpon()
                    .appendQueryParameter("nativeWrapper", BuildConfig.VERSION_NAME)
                    .appendQueryParameter("nativeCacheEpoch", prefs.cacheEpoch)
                    .build()
                    .toString()
            } catch (_: Exception) {
                base
            }
        }

        fun isHttpUrl(url: String): Boolean {
            val lower = url.lowercase()
            return lower.startsWith("https://") || lower.startsWith("http://")
        }
    }
}
