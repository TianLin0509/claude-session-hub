package com.lintian.hubmobile

import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 应用内自更新：
 *  1. 启动 / onResume 时检查 wrapper-version.json
 *  2. 发现 versionCode > 当前 → 弹框提示
 *  3. 用户同意 → DownloadManager 下载 APK
 *  4. 下载完成 → 调系统安装器（FileProvider）
 * 装完一次后再也不需要电脑/数据线传 APK。
 */
class WrapperUpdater(
    private val context: Context,
    private val prefs: HubPrefs,
) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private var downloadReceiver: BroadcastReceiver? = null

    /**
     * 检查远程版本。
     * silent = true：无新版本不打扰；有新版本弹对话框
     * silent = false：始终弹结果（用于"手动检查更新"）
     */
    fun checkUpdate(silent: Boolean = true) {
        if (silent) {
            val sinceLast = System.currentTimeMillis() - prefs.lastUpdateCheckMs
            if (sinceLast in 0..MIN_CHECK_INTERVAL_MS) {
                Log.d(TAG, "skip update check (last check ${sinceLast / 1000}s ago)")
                return
            }
        }
        prefs.lastUpdateCheckMs = System.currentTimeMillis()
        val url = prefs.updateCheckUrl
        Thread {
            try {
                val resp = client.newCall(Request.Builder().url(url).build()).execute()
                if (!resp.isSuccessful) {
                    Log.w(TAG, "update check failed: HTTP ${resp.code}")
                    if (!silent) toast("检查更新失败: HTTP ${resp.code}")
                    resp.close()
                    return@Thread
                }
                val body = resp.body?.string() ?: ""
                resp.close()
                val obj = JSONObject(body)
                val remoteCode = obj.optInt("versionCode", 0)
                val remoteName = obj.optString("versionName", "")
                val apkUrl = obj.optString("apkUrl", "")
                val notes = obj.optString("releaseNotes", "")
                val currentCode = BuildConfig.VERSION_CODE
                Log.i(TAG, "remote=$remoteCode($remoteName) local=$currentCode")
                if (remoteCode <= currentCode || apkUrl.isEmpty()) {
                    if (!silent) toast("已是最新版本 ${BuildConfig.VERSION_NAME}")
                    return@Thread
                }
                runOnUi { promptInstall(remoteName, apkUrl, notes) }
            } catch (e: Exception) {
                Log.w(TAG, "update check error: ${e.message}")
                if (!silent) toast("检查更新失败: ${e.message}")
            }
        }.start()
    }

    private fun promptInstall(versionName: String, apkUrl: String, notes: String) {
        AlertDialog.Builder(context)
            .setTitle("有新版本 $versionName")
            .setMessage(if (notes.isNotBlank()) notes else "立即下载安装？")
            .setPositiveButton("立即更新") { _, _ -> downloadAndInstall(apkUrl, versionName) }
            .setNegativeButton("稍后", null)
            .setCancelable(true)
            .show()
    }

    private fun downloadAndInstall(apkUrl: String, versionName: String) {
        toast("开始下载 $versionName")
        val fileName = "HubMobile-$versionName.apk"
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val req = DownloadManager.Request(Uri.parse(apkUrl)).apply {
            setTitle("Hub 更新 $versionName")
            setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, fileName)
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setAllowedOverMetered(true)
            setAllowedOverRoaming(true)
            setMimeType("application/vnd.android.package-archive")
        }
        val downloadId = dm.enqueue(req)
        registerDownloadReceiver(downloadId, fileName)
    }

    private fun registerDownloadReceiver(downloadId: Long, fileName: String) {
        unregisterReceiver()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
                if (id != downloadId) return
                val file = File(
                    context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
                    fileName
                )
                if (file.exists()) {
                    triggerInstall(file)
                } else {
                    toast("下载失败")
                }
                unregisterReceiver()
            }
        }
        downloadReceiver = receiver
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(receiver, filter)
        }
    }

    fun unregisterReceiver() {
        downloadReceiver?.let {
            try { context.unregisterReceiver(it) } catch (_: Exception) {}
        }
        downloadReceiver = null
    }

    private fun triggerInstall(apk: File) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            && !context.packageManager.canRequestPackageInstalls()
        ) {
            toast("请允许 Hub 安装未知应用，再点检查更新")
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try { context.startActivity(intent) } catch (_: Exception) {}
            return
        }
        try {
            val uri = FileProvider.getUriForFile(
                context, "${context.packageName}.fileprovider", apk
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (e: Exception) {
            toast("启动安装失败: ${e.message}")
        }
    }

    private fun runOnUi(block: () -> Unit) {
        android.os.Handler(android.os.Looper.getMainLooper()).post(block)
    }
    private fun toast(msg: String) {
        runOnUi { Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() }
    }

    companion object {
        private const val TAG = "WrapperUpdater"
        private const val MIN_CHECK_INTERVAL_MS = 60_000L  // 同一进程内 1 分钟最多检查一次
    }
}
