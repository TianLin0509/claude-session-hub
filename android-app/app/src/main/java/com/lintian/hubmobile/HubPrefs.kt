package com.lintian.hubmobile

import android.content.Context
import android.content.SharedPreferences

/**
 * 集中管理 Wrapper 的本地偏好设置。
 * 避免 PWA URL / 自更新策略硬编码——未来修改无需重装 APK。
 */
class HubPrefs(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("hub_wrapper", Context.MODE_PRIVATE)

    var pwaUrl: String
        get() = sp.getString(KEY_PWA_URL, DEFAULT_PWA_URL) ?: DEFAULT_PWA_URL
        set(value) { sp.edit().putString(KEY_PWA_URL, value).apply() }

    var updateCheckUrl: String
        get() = sp.getString(KEY_UPDATE_URL, DEFAULT_UPDATE_URL) ?: DEFAULT_UPDATE_URL
        set(value) { sp.edit().putString(KEY_UPDATE_URL, value).apply() }

    var remoteConfigUrl: String
        get() = sp.getString(KEY_REMOTE_CONFIG_URL, DEFAULT_REMOTE_CONFIG_URL) ?: DEFAULT_REMOTE_CONFIG_URL
        set(value) { sp.edit().putString(KEY_REMOTE_CONFIG_URL, value).apply() }

    var cacheEpoch: String
        get() = sp.getString(KEY_CACHE_EPOCH, "0") ?: "0"
        set(value) { sp.edit().putString(KEY_CACHE_EPOCH, value).apply() }

    var forceNoCache: Boolean
        get() = sp.getBoolean(KEY_FORCE_NO_CACHE, false)
        set(value) { sp.edit().putBoolean(KEY_FORCE_NO_CACHE, value).apply() }

    var autoCheckUpdate: Boolean
        get() = sp.getBoolean(KEY_AUTO_UPDATE, true)
        set(value) { sp.edit().putBoolean(KEY_AUTO_UPDATE, value).apply() }

    var lastUpdateCheckMs: Long
        get() = sp.getLong(KEY_LAST_CHECK, 0L)
        set(value) { sp.edit().putLong(KEY_LAST_CHECK, value).apply() }

    var lastRemoteConfigCheckMs: Long
        get() = sp.getLong(KEY_LAST_REMOTE_CONFIG_CHECK, 0L)
        set(value) { sp.edit().putLong(KEY_LAST_REMOTE_CONFIG_CHECK, value).apply() }

    fun reset() {
        sp.edit().clear().apply()
    }

    companion object {
        const val DEFAULT_PWA_URL = "https://lthub.xyz:8443/"
        const val DEFAULT_UPDATE_URL = "https://lthub.xyz:8443/mobile/wrapper-version.json"
        const val DEFAULT_REMOTE_CONFIG_URL = "https://lthub.xyz:8443/mobile/wrapper-config.json"
        private const val KEY_PWA_URL = "pwa_url"
        private const val KEY_UPDATE_URL = "update_url"
        private const val KEY_REMOTE_CONFIG_URL = "remote_config_url"
        private const val KEY_CACHE_EPOCH = "cache_epoch"
        private const val KEY_FORCE_NO_CACHE = "force_no_cache"
        private const val KEY_AUTO_UPDATE = "auto_update"
        private const val KEY_LAST_CHECK = "last_update_check_ms"
        private const val KEY_LAST_REMOTE_CONFIG_CHECK = "last_remote_config_check_ms"
    }
}
