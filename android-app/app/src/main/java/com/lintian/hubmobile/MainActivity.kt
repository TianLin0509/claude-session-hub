package com.lintian.hubmobile

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Hub Mobile · 完整 WebView Wrapper（v0.2.0+）。
 *
 * 长期投资点：让 PWA 改动尽量都不需要重装 APK。
 *
 *  - PWA URL 配置化（HubPrefs，可远程切换 / 配置面板覆盖）
 *  - 应用内自更新（WrapperUpdater）
 *  - JS Bridge `window.HubNative.*`（HubNativeBridge）
 *  - 三指点击屏顶 30dp 区域 1.5 秒 → ConfigActivity（PWA 也可调用 HubNative.openConfigPanel）
 *  - DownloadListener 让 PWA 触发的下载走系统 DownloadManager
 *  - 错误页 + retry（断网时不显示 ERR_NAME_NOT_RESOLVED 难看页）
 *  - RenderProcess 崩溃自动恢复
 *  - 沉浸全屏 / 安全状态栏 / 软键盘 adjustResize
 *  - 持久化 Cookie / DOM Storage / IndexedDB / Service Worker
 *  - 自定义 UA 后缀 `HubWrapper/x.x.x` 让 VPS 端识别
 */
class MainActivity : ComponentActivity() {

    private lateinit var prefs: HubPrefs
    private lateinit var webView: WebView
    private lateinit var updater: WrapperUpdater
    private lateinit var remoteConfig: RemoteConfigManager
    private lateinit var bridge: HubNativeBridge
    private var errorOverlay: View? = null
    private var loadingFailed = false

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = HubPrefs(this)

        // ① 沉浸全屏
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !isNightMode()
            isAppearanceLightNavigationBars = !isNightMode()
        }
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)

        // ② WebView
        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.WHITE)
        }
        configureWebView(webView)

        // ③ Updater + JS Bridge
        updater = WrapperUpdater(this, prefs)
        remoteConfig = RemoteConfigManager(this, prefs) { webView }
        bridge = HubNativeBridge(this, webView, updater, remoteConfig, prefs)
        webView.addJavascriptInterface(bridge, HubNativeBridge.NAME)

        // ④ 隐藏入口：顶部 30dp 透明区域，三指长按 1.5s → ConfigActivity
        val secretTrigger = makeSecretTrigger()

        // ⑤ 根容器：先 WebView，再透明触发器（z 序高）
        val root = FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
            addView(webView)
            addView(secretTrigger)
        }
        setContentView(root)

        // ⑥ 返回键：WebView 优先后退
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (errorOverlay != null) { hideError(); return }
                if (webView.canGoBack()) webView.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        // ⑦ 加载
        loadCurrentPwa()
        Handler(Looper.getMainLooper()).postDelayed({
            remoteConfig.fetchAndApply(silent = true, force = true)
        }, 1200)

        // ⑧ 启动检查更新（silent）
        if (prefs.autoCheckUpdate) {
            Handler(Looper.getMainLooper()).postDelayed({ updater.checkUpdate(silent = true) }, 4000)
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun makeSecretTrigger(): View {
        val trigger = View(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
        }
        val h = (resources.displayMetrics.density * 40).toInt()
        trigger.layoutParams = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, h
        )
        // 三指按下 → 1.5 秒后弹出 ConfigActivity
        val longPressMs = 1500L
        val handler = Handler(Looper.getMainLooper())
        val openConfig = Runnable {
            startActivity(Intent(this, ConfigActivity::class.java))
        }
        trigger.setOnTouchListener { v, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_DOWN -> {
                    if (ev.pointerCount >= 3) {
                        handler.postDelayed(openConfig, longPressMs)
                    }
                    false // 不消费，让 WebView 仍能收到（PWA SafeArea 区如果有按钮也能用）
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                    handler.removeCallbacks(openConfig)
                    false
                }
                else -> false
            }
        }
        return trigger
    }

    private fun isNightMode(): Boolean {
        val mode = resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK
        return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView) {
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            loadWithOverviewMode = true
            useWideViewPort = true
            setSupportZoom(false)
            displayZoomControls = false
            builtInZoomControls = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            javaScriptCanOpenWindowsAutomatically = true
            setSupportMultipleWindows(false)
            userAgentString = "$userAgentString HubWrapper/${BuildConfig.VERSION_NAME}"
        }

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(wv, true)
        }

        wv.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                // 同 host 的请求走 WebView；其他打开系统浏览器
                val host = request.url.host ?: ""
                val pwaHost = Uri.parse(prefs.pwaUrl).host ?: ""
                if (host == pwaHost) return false
                if (url.startsWith("mailto:") || url.startsWith("tel:") || url.startsWith("sms:")) {
                    return try {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        true
                    } catch (_: Exception) { false }
                }
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    true
                } catch (_: Exception) { false }
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                loadingFailed = false
                hideError()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                remoteConfig.injectNativeReady()
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // 只对主请求显示错误（子资源失败不打扰）
                if (request.isForMainFrame) {
                    loadingFailed = true
                    showError("加载失败 ${error.errorCode}\n${error.description}")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // WebView 渲染进程崩溃 → 移除并重建，避免整个 App 闪退
                (view.parent as? FrameLayout)?.removeView(view)
                webView = WebView(this@MainActivity).also {
                    it.layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                    configureWebView(it)
                    it.addJavascriptInterface(bridge, HubNativeBridge.NAME)
                }
                val root = findViewById<FrameLayout>(android.R.id.content)
                (root.getChildAt(0) as? FrameLayout)?.addView(webView, 0)
                loadCurrentPwa()
                return true
            }
        }

        wv.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                android.util.Log.d("PWA", "${msg.sourceId()}:${msg.lineNumber()} ${msg.message()}")
                return true
            }
            override fun onPermissionRequest(request: PermissionRequest) {
                // PWA 申请相机/麦克风权限时直接 grant（已在 manifest 声明）
                runOnUiThread { request.grant(request.resources) }
            }
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: android.webkit.ValueCallback<Array<android.net.Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                return try {
                    val intent = fileChooserParams.createIntent()
                    fileChooseCallback = filePathCallback
                    startActivityForResult(intent, REQ_FILE_CHOOSE)
                    true
                } catch (_: Exception) {
                    filePathCallback.onReceiveValue(null)
                    false
                }
            }
        }

        // DownloadListener：PWA 触发的下载（如 a[download]）走 DownloadManager
        wv.setDownloadListener(DownloadListener { url, _, _, mimetype, _ ->
            try {
                val req = android.app.DownloadManager.Request(Uri.parse(url)).apply {
                    setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setMimeType(mimetype ?: "application/octet-stream")
                    setDestinationInExternalFilesDir(
                        this@MainActivity,
                        android.os.Environment.DIRECTORY_DOWNLOADS,
                        "hub-${System.currentTimeMillis()}"
                    )
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as android.app.DownloadManager).enqueue(req)
                Toast.makeText(this, "开始下载", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "下载失败: ${e.message}", Toast.LENGTH_SHORT).show()
            }
        })

        // Debug 版本可远程调试
        if (0 != applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
    }

    private var fileChooseCallback: android.webkit.ValueCallback<Array<Uri>>? = null

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE_CHOOSE) {
            val cb = fileChooseCallback ?: return
            fileChooseCallback = null
            cb.onReceiveValue(android.webkit.WebChromeClient.FileChooserParams.parseResult(resultCode, data))
        }
    }

    private fun showError(message: String) {
        if (errorOverlay != null) return
        val overlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(Color.parseColor("#FAFAFA"))
            setPadding(dp(32), dp(32), dp(32), dp(32))
        }
        val title = TextView(this).apply {
            text = "无法连接到 Hub"
            setTextColor(Color.parseColor("#1d1d1f"))
            textSize = 22f
            setTypeface(null, android.graphics.Typeface.BOLD)
            gravity = android.view.Gravity.CENTER
        }
        val msg = TextView(this).apply {
            text = message
            setTextColor(Color.parseColor("#6e6e73"))
            textSize = 13f
            gravity = android.view.Gravity.CENTER
            setPadding(0, dp(12), 0, dp(24))
        }
        val retry = Button(this).apply {
            text = "重试"
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#0071e3"))
            setOnClickListener {
                hideError()
                loadCurrentPwa()
            }
        }
        val cfg = Button(this).apply {
            text = "打开设置"
            isAllCaps = false
            setTextColor(Color.parseColor("#0071e3"))
            setBackgroundColor(Color.parseColor("#FAFAFA"))
            setOnClickListener {
                startActivity(Intent(this@MainActivity, ConfigActivity::class.java))
            }
        }
        overlay.addView(title)
        overlay.addView(msg)
        overlay.addView(retry, LinearLayout.LayoutParams(dp(200), dp(48)))
        overlay.addView(cfg, LinearLayout.LayoutParams(dp(200), dp(48)).apply { topMargin = dp(8) })

        val root = (findViewById<FrameLayout>(android.R.id.content).getChildAt(0) as FrameLayout)
        root.addView(overlay, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
        errorOverlay = overlay
    }

    private fun hideError() {
        errorOverlay?.let {
            (it.parent as? FrameLayout)?.removeView(it)
            errorOverlay = null
        }
    }

    override fun onResume() {
        super.onResume()
        // 每次切回前台，给一次更新检查（silent，受 60s 节流保护）
        if (prefs.autoCheckUpdate) updater.checkUpdate(silent = true)
        remoteConfig.fetchAndApply(silent = true)
        ensureExpectedPwaLoaded()
        // 让 PWA 知道 wrapper 回到前台（PWA 可重连 WSS）
        webView.evaluateJavascript("window.dispatchEvent(new Event('hub:resume'))", null)
    }

    override fun onDestroy() {
        updater.unregisterReceiver()
        webView.destroy()
        super.onDestroy()
    }

    private fun loadCurrentPwa() {
        webView.loadUrl(RemoteConfigManager.buildPwaUrl(prefs))
    }

    private fun ensureExpectedPwaLoaded() {
        val current = webView.url ?: return
        val expected = Uri.parse(prefs.pwaUrl)
        val actual = Uri.parse(current)
        if (expected.host != actual.host || expected.path != actual.path) {
            loadCurrentPwa()
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val REQ_FILE_CHOOSE = 9001
    }
}
