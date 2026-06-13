package com.lintian.hubmobile

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity

/**
 * 隐藏入口的 wrapper 配置面板（不要进 PWA UI，长按状态栏区域触发）。
 * 让用户能：改 PWA URL、改 update URL、关自动检查、清缓存、查看版本/native info、立即检查更新。
 *
 * UI 用代码构建，避免 layout xml 依赖。
 */
class ConfigActivity : ComponentActivity() {

    private lateinit var prefs: HubPrefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = HubPrefs(this)

        val updater = WrapperUpdater(this, prefs)

        val scroll = ScrollView(this)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(40), dp(20), dp(40))
            setBackgroundColor(Color.parseColor("#FAFAFA"))
        }
        scroll.addView(root)
        setContentView(scroll)

        title("Hub Wrapper 设置", root)
        info("版本", "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", root)
        info("包名", packageName, root)
        info("设备", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} · Android ${android.os.Build.VERSION.RELEASE}", root)
        spacer(root)

        section("PWA 加载地址", root)
        val urlInput = EditText(this).apply {
            setText(prefs.pwaUrl)
            setSingleLine(true)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(Color.parseColor("#1d1d1f"))
        }
        root.addView(urlInput, lp(matchParent = true))

        section("自更新检查地址", root)
        val updUrlInput = EditText(this).apply {
            setText(prefs.updateCheckUrl)
            setSingleLine(true)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(Color.parseColor("#1d1d1f"))
        }
        root.addView(updUrlInput, lp(matchParent = true))

        section("Remote wrapper config URL", root)
        val remoteConfigInput = EditText(this).apply {
            setText(prefs.remoteConfigUrl)
            setSingleLine(true)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setTextColor(Color.parseColor("#1d1d1f"))
        }
        root.addView(remoteConfigInput, lp(matchParent = true))

        spacer(root)
        val autoSwitch = Switch(this).apply {
            text = "  启动时自动检查更新"
            isChecked = prefs.autoCheckUpdate
            setTextColor(Color.parseColor("#1d1d1f"))
        }
        root.addView(autoSwitch, lp(matchParent = true))

        spacer(root, h = 24)

        button("保存并应用", root, primary = true) {
            prefs.pwaUrl = urlInput.text.toString().trim()
            prefs.updateCheckUrl = updUrlInput.text.toString().trim()
            prefs.remoteConfigUrl = remoteConfigInput.text.toString().trim()
            prefs.autoCheckUpdate = autoSwitch.isChecked
            Toast.makeText(this, "已保存，重新加载 PWA", Toast.LENGTH_SHORT).show()
            setResult(Activity.RESULT_OK)
            finish()
        }
        spacer(root)
        button("立即检查更新", root) {
            updater.checkUpdate(silent = false)
        }
        spacer(root)
        button("清除全部缓存 + 重新加载", root) {
            android.webkit.WebStorage.getInstance().deleteAllData()
            android.webkit.CookieManager.getInstance().removeAllCookies(null)
            Toast.makeText(this, "已清除 storage/cookie，请回到主页", Toast.LENGTH_SHORT).show()
        }
        spacer(root)
        button("恢复默认设置", root, danger = true) {
            prefs.reset()
            Toast.makeText(this, "已恢复默认", Toast.LENGTH_SHORT).show()
            recreate()
        }
        spacer(root, h = 24)
        button("关闭", root) { finish() }
    }

    private fun title(text: String, parent: LinearLayout) {
        val tv = TextView(this).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#1d1d1f"))
            setPadding(0, 0, 0, dp(8))
        }
        parent.addView(tv, lp(matchParent = true))
    }

    private fun section(text: String, parent: LinearLayout) {
        val tv = TextView(this).apply {
            this.text = text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.parseColor("#6e6e73"))
            setPadding(0, dp(16), 0, dp(6))
        }
        parent.addView(tv, lp(matchParent = true))
    }

    private fun info(label: String, value: String, parent: LinearLayout) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val l = TextView(this).apply {
            text = "$label:"
            setTextColor(Color.parseColor("#6e6e73"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        }
        val v = TextView(this).apply {
            text = value
            setTextColor(Color.parseColor("#1d1d1f"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(dp(8), 0, 0, 0)
        }
        row.addView(l)
        row.addView(v)
        parent.addView(row, lp(matchParent = true))
    }

    private fun button(text: String, parent: LinearLayout, primary: Boolean = false, danger: Boolean = false, onClick: () -> Unit) {
        val b = Button(this).apply {
            this.text = text
            isAllCaps = false
            setTextColor(Color.WHITE)
            setBackgroundColor(
                when {
                    danger -> Color.parseColor("#ff3b30")
                    primary -> Color.parseColor("#0071e3")
                    else -> Color.parseColor("#48484a")
                }
            )
            setOnClickListener { onClick() }
        }
        parent.addView(b, lp(matchParent = true).apply { height = dp(48) })
    }

    private fun spacer(parent: LinearLayout, h: Int = 12) {
        val s = View(this)
        parent.addView(s, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(h)))
    }

    private fun lp(matchParent: Boolean = false): LinearLayout.LayoutParams {
        val w = if (matchParent) ViewGroup.LayoutParams.MATCH_PARENT else ViewGroup.LayoutParams.WRAP_CONTENT
        return LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
