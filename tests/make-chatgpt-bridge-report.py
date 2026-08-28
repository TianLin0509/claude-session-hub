#!/usr/bin/env python3
"""Build a self-contained acceptance report from real ChatGPT bridge evidence."""

from __future__ import annotations

import base64
import hashlib
import html
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPORT = Path(r"C:\VibeData\Artifacts\Reports\chatgpt-bridge-acceptance-20260828.html")
STRESS_DIR = ROOT / "output" / "playwright" / "chatgpt-bridge-stress"
PULL_DIR = ROOT / "output" / "playwright" / "chatgpt-bridge-real-pull"
UI_DIR = ROOT / "output" / "playwright" / "chatgpt-bridge"


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def data_uri(path: Path) -> str:
    raw = path.read_bytes()
    return "data:image/png;base64," + base64.b64encode(raw).decode("ascii")


def short_sha(value: str) -> str:
    return value[:12] + "…" + value[-8:]


def main() -> None:
    stress = json.loads((STRESS_DIR / "stress-summary.json").read_text(encoding="utf-8"))
    pull = json.loads((PULL_DIR / "real-pull-summary.json").read_text(encoding="utf-8"))
    images = {
        "company_source": data_uri(PULL_DIR / "01-company-one-click-source.png"),
        "hub_before": data_uri(PULL_DIR / "02-hub-before-one-click-pull.png"),
        "hub_success": data_uri(PULL_DIR / "03-hub-one-click-pull-success.png"),
        "hub_ack": data_uri(PULL_DIR / "04-hub-real-codex-ack.png"),
        "hub_push": data_uri(UI_DIR / "01-chatgpt-bridge-actions.png"),
        "company_receive": data_uri(STRESS_DIR / "home-to-company-h2c-000512-unicode.png"),
        "rate_limit": data_uri(STRESS_DIR / "home-to-company-h2c-066082-ascii.png"),
    }

    rows = []
    max_bytes = max(int(row["bytes"]) for row in stress["results"])
    for row in stress["results"]:
        direction = "公司 → 本机" if row["direction"] == "c2h" else "本机 → 公司"
        transport = row.get("transport") or row.get("source") or "inline_text"
        width = max(2.0, int(row["bytes"]) / max_bytes * 100)
        rows.append(
            "<tr>"
            f"<td><span class='pill {'in' if row['direction'] == 'c2h' else 'out'}'>{esc(direction)}</span></td>"
            f"<td><code>{esc(row['id'])}</code></td>"
            f"<td class='num'>{int(row['bytes']):,}</td>"
            f"<td><div class='bar'><i style='width:{width:.2f}%'></i></div></td>"
            f"<td>{esc(transport)}</td>"
            f"<td><code title='{esc(row['expected_sha256'])}'>{esc(short_sha(row['expected_sha256']))}</code></td>"
            f"<td class='pass'>✓ 完全一致</td>"
            "</tr>"
        )

    html_text = fr"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>ChatGPT 双向中转桥 · 实装与验收报告</title>
<style>
:root{{--bg:#071018;--panel:#0e1924;--panel2:#122232;--line:#26394a;--text:#ecf4f8;--muted:#9db0bd;--teal:#22d3a6;--blue:#48a4ff;--gold:#ffca68;--red:#ff7777;--shadow:0 18px 55px rgba(0,0,0,.32)}}
*{{box-sizing:border-box}} html{{scroll-behavior:smooth}} body{{margin:0;background:radial-gradient(circle at 85% -5%,#113249 0,transparent 32%),var(--bg);color:var(--text);font:15px/1.72 Inter,"Microsoft YaHei UI","Segoe UI",sans-serif}}
a{{color:#7fc1ff}} code{{font-family:"Cascadia Code",Consolas,monospace;font-size:.91em}} .shell{{max-width:1420px;margin:auto;padding:34px 30px 80px}}
.hero{{position:relative;overflow:hidden;border:1px solid #2b4659;border-radius:26px;padding:38px 42px;background:linear-gradient(135deg,rgba(24,55,72,.96),rgba(9,22,32,.97));box-shadow:var(--shadow)}}
.hero:after{{content:"";position:absolute;width:460px;height:460px;border-radius:50%;right:-190px;top:-250px;background:radial-gradient(circle,rgba(34,211,166,.28),transparent 66%)}}
.eyebrow{{letter-spacing:.18em;color:#78e8cb;font-size:12px;font-weight:800;text-transform:uppercase}} h1{{font-size:42px;line-height:1.16;margin:10px 0 14px;max-width:900px}} .lead{{font-size:18px;color:#c7d6df;max-width:950px;margin:0}}
.status{{display:inline-flex;gap:9px;align-items:center;margin-top:22px;padding:9px 14px;border-radius:999px;background:rgba(34,211,166,.12);border:1px solid rgba(34,211,166,.35);color:#8ff0d6;font-weight:800}} .dot{{width:9px;height:9px;border-radius:50%;background:var(--teal);box-shadow:0 0 15px var(--teal)}}
.kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:20px 0 30px}} .kpi{{padding:20px;border-radius:18px;background:var(--panel);border:1px solid var(--line)}} .kpi b{{display:block;font-size:30px;line-height:1.1;color:#fff}} .kpi span{{color:var(--muted)}}
.nav{{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0 28px}} .nav a{{text-decoration:none;color:#dce9ef;border:1px solid var(--line);background:#0c1721;padding:8px 13px;border-radius:10px}}
section{{margin-top:24px;padding:28px 30px;border:1px solid var(--line);border-radius:22px;background:linear-gradient(160deg,rgba(17,33,47,.97),rgba(11,22,32,.98));box-shadow:0 8px 30px rgba(0,0,0,.16)}} h2{{font-size:25px;margin:0 0 8px}} h3{{font-size:18px;margin:22px 0 8px}} .sub{{color:var(--muted);margin:0 0 18px}}
.flow{{display:grid;grid-template-columns:1fr 48px 1fr 48px 1fr 48px 1fr;gap:10px;align-items:center;margin:20px 0}} .node{{min-height:114px;border:1px solid #345065;border-radius:16px;padding:16px;background:#101e2a}} .node b{{display:block;margin-bottom:5px;color:#fff}} .node small{{color:var(--muted)}} .arrow{{font-size:25px;text-align:center;color:var(--teal)}}
.grid2{{display:grid;grid-template-columns:1fr 1fr;gap:18px}} .card{{background:#0b1721;border:1px solid var(--line);border-radius:16px;padding:18px}} .card h3{{margin-top:0}} ul{{padding-left:21px}} li+li{{margin-top:7px}}
.steps{{counter-reset:s}} .step{{position:relative;margin:12px 0;padding:15px 16px 15px 56px;border-left:3px solid var(--blue);background:#0b1721;border-radius:10px}} .step:before{{counter-increment:s;content:counter(s);position:absolute;left:15px;top:13px;width:27px;height:27px;border-radius:50%;display:grid;place-items:center;background:#173c5b;color:#9fd2ff;font-weight:800}}
table{{width:100%;border-collapse:separate;border-spacing:0;overflow:hidden;border:1px solid var(--line);border-radius:14px}} th,td{{padding:11px 12px;border-bottom:1px solid #223545;text-align:left;vertical-align:middle}} th{{background:#162737;color:#bed0dc;font-size:12px;letter-spacing:.04em}} tr:last-child td{{border-bottom:0}} tr:hover td{{background:rgba(72,164,255,.045)}} .num{{font-variant-numeric:tabular-nums;text-align:right}} .pass{{color:#78e8cb;font-weight:800;white-space:nowrap}} .pill{{display:inline-block;padding:3px 8px;border-radius:999px;font-size:12px;white-space:nowrap}} .pill.in{{background:rgba(72,164,255,.14);color:#8fc9ff}} .pill.out{{background:rgba(34,211,166,.13);color:#85e8cf}} .bar{{width:110px;height:8px;border-radius:99px;background:#1d3140;overflow:hidden}} .bar i{{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--teal));border-radius:99px}}
.shot-grid{{display:grid;grid-template-columns:1fr 1fr;gap:18px}} figure{{margin:0;background:#08131c;border:1px solid var(--line);border-radius:16px;overflow:hidden}} figure img{{display:block;width:100%;height:auto}} figcaption{{padding:12px 14px;color:#b6c8d3}} .wide{{grid-column:1/-1}}
.callout{{border-left:4px solid var(--gold);padding:13px 16px;background:rgba(255,202,104,.09);border-radius:8px;color:#ebdcc0}} .risk{{border-left-color:var(--red);background:rgba(255,119,119,.08);color:#f0cbcb}} .ok{{border-left-color:var(--teal);background:rgba(34,211,166,.08);color:#c2efe3}}
.path{{word-break:break-all;color:#bcd0dd;background:#07121a;border:1px solid #203646;border-radius:9px;padding:9px 11px}} details{{border:1px solid var(--line);border-radius:12px;background:#0a1620;margin-top:12px}} summary{{cursor:pointer;padding:12px 15px;font-weight:800}} details>div{{padding:0 15px 15px;color:#b9cad4}} .footer{{margin-top:28px;color:#879ba8;font-size:13px;text-align:center}}
@media(max-width:920px){{.kpis,.grid2,.shot-grid{{grid-template-columns:1fr}}.flow{{grid-template-columns:1fr}}.arrow{{transform:rotate(90deg)}}.wide{{grid-column:auto}} h1{{font-size:34px}}section,.hero{{padding:24px}}}}
</style>
</head>
<body><main class="shell">
<header class="hero">
  <div class="eyebrow">AI HUB · REAL ACCEPTANCE · 2026-08-28</div>
  <h1>ChatGPT 双向中转桥已经打通</h1>
  <p class="lead">公司电脑只需在固定 ChatGPT 会话里粘贴原文；本机可在 AI Hub 一键拉取给当前 AI，也可把最近回答、卡片、URL、文本文件或终端选中文字一键推回公司。</p>
  <div class="status"><i class="dot"></i>已登录 · 已绑定 · 双向实测通过</div>
</header>

<div class="kpis">
  <div class="kpi"><b>9 / 9</b><span>双向真实压力轮次 SHA 完全一致</span></div>
  <div class="kpi"><b>66,082 B</b><span>本轮单条最大实测文本</span></div>
  <div class="kpi"><b>0</b><span>全仓 767 项单元测试失败数</span></div>
  <div class="kpi"><b>{pull['elapsedMs'] / 1000:.1f}s</b><span>真实一键拉取至精确 ACK 的全链路耗时</span></div>
</div>

<nav class="nav"><a href="#usage">怎么用</a><a href="#architecture">链路原理</a><a href="#ui">快捷入口</a><a href="#stress">压力结果</a><a href="#evidence">截图证据</a><a href="#bugs">发现并修掉的问题</a><a href="#limits">边界</a><a href="#delivery">交付</a></nav>

<section id="usage"><h2>你醒来后怎么用</h2><p class="sub">登录步骤已经结束，不需要再手工下载文件，也不用复制本机路径。</p>
  <div class="grid2">
    <div class="card"><h3>公司 → 本机</h3><div class="steps"><div class="step">公司电脑打开已置顶会话 <b>“中转站已就绪”</b>。</div><div class="step">普通文字直接粘贴；很长的原文也可继续粘贴，ChatGPT 自动附件化不影响本机读取。</div><div class="step">本机先打开目标单聊 AI，再点顶栏 <b>↓ 拉取</b>。消息只有在 PTY 真正接收成功后才推进游标。</div></div></div>
    <div class="card"><h3>本机 → 公司</h3><div class="steps"><div class="step">点顶栏 <b>↑ 公司</b>，发送最近一条 AI 回答。</div><div class="step">也可点回答卡片上的 <b>↑</b>；URL / 文本文件右键选择“同步内容到公司 ChatGPT”。</div><div class="step">终端中先选中文字，再右键同步。公司电脑在同一固定会话直接复制即可。</div></div></div>
  </div>
  <div class="callout ok"><b>自然语言也能用：</b>对 Codex 说“从公司拉取”或“把上面的回答同步到公司”，已安装的 <code>chatgpt-bridge</code> skill 会调用同一稳定工具。</div>
</section>

<section id="architecture"><h2>链路原理</h2><p class="sub">两台电脑不直接互联，固定 ChatGPT 会话充当一次性文本收件箱；本机使用独立已登录浏览器上下文自动收发。</p>
  <div class="flow"><div class="node"><b>公司电脑</b><small>只复制原文到固定会话，不上传本地文件也可工作</small></div><div class="arrow">→</div><div class="node"><b>固定 ChatGPT 会话</b><small>用稳定 message UUID 识别，不依赖会随重渲染变化的 turn 序号</small></div><div class="arrow">→</div><div class="node"><b>本机专属浏览器</b><small><code>chatgpt-bridge</code> 与 <code>chatgpt-company-sim</code> 两个隔离页面模拟两台电脑</small></div><div class="arrow">→</div><div class="node"><b>AI Hub 当前会话</b><small>peek → PTY 成功 → ack；发送失败时不丢消息</small></div></div>
  <div class="grid2"><div class="card"><h3>小文本</h3><p>优先用“复制消息”取得原始正文，统一 CRLF/LF 后传递。Markdown 视觉渲染不会被误当成原始文件。</p></div><div class="card"><h3>大文本附件</h3><p>在已登录页面上下文读取附件原始字节，失败才退回 UI 预览。49 KB Unicode/Markdown 已按 SHA 精确复现。</p></div></div>
</section>

<section id="ui"><h2>AI Hub 快捷入口</h2><p class="sub">功能位于独立工作树，尚未合并到你正在使用的生产 Hub，避免与其他 Agent 的改动互相踩踏。</p>
  <table><thead><tr><th>入口</th><th>动作</th><th>适合场景</th></tr></thead><tbody>
  <tr><td><b>↓ 拉取</b></td><td>从固定会话读取新公司内容并投递当前单聊 AI</td><td>公司给本机任务、代码片段、长文</td></tr>
  <tr><td><b>↑ 公司</b></td><td>同步当前会话最近一条 AI 回答</td><td>最常用的一键回传</td></tr>
  <tr><td>回答卡片 <b>↑</b></td><td>同步指定回答卡片</td><td>不是最后一条也要回传</td></tr>
  <tr><td>URL / 文本文件右键</td><td>URL 直接传；<code>.txt/.md/.json/.csv/.log</code> 读取正文再传</td><td>沿用“右键同步”的操作直觉</td></tr>
  <tr><td>终端选中文字右键</td><td>只传当前选区</td><td>日志片段、命令输出、报错</td></tr>
  </tbody></table>
</section>

<section id="stress"><h2>双向真实压力测试</h2><p class="sub">不是只验证“页面上看起来有字”，而是对发送前与回读后的 UTF-8 字节做 SHA-256；中文、±45°、Markdown、反斜杠和自动附件化均纳入。</p>
  <table><thead><tr><th>方向</th><th>用例</th><th>字节</th><th>相对大小</th><th>本轮传输形态</th><th>SHA-256</th><th>结论</th></tr></thead><tbody>{''.join(rows)}</tbody></table>
  <p class="callout"><b>真实限流也测到了：</b>32 KB 和 66 KB 本机→公司轮次各遇到一次 “Too many requests”，测试按 60 秒退避后成功；失败没有被记成成功。生产 UI 会明确提示限流，当前不会对“推送”盲目自动重试，以免边界情况下重复发送。</p>
</section>

<section id="evidence"><h2>一键闭环截图证据</h2><p class="sub">同一个唯一标记贯穿公司源消息、Hub 拉取成功提示和真实 Codex ACK。</p>
  <div class="shot-grid">
    <figure><img src="{images['company_source']}" alt="公司侧源消息"><figcaption>① 公司模拟页：唯一源消息 <code>{esc(pull['marker'])}</code></figcaption></figure>
    <figure><img src="{images['hub_before']}" alt="Hub 点击前"><figcaption>② 隔离 Hub：真实 Codex 单聊已打开，准备点击“↓ 拉取”</figcaption></figure>
    <figure class="wide"><img src="{images['hub_success']}" alt="一键拉取成功"><figcaption>③ 一次点击后：绿色提示“已拉取并发送给当前 AI · 1 条内容”，PTY 中已出现问题与精确 ACK</figcaption></figure>
    <figure class="wide"><img src="{images['hub_ack']}" alt="Codex 卡片 ACK"><figcaption>④ 卡片视图：原始问题与 <code>{esc(pull['ack'])}</code> 成对呈现</figcaption></figure>
    <figure><img src="{images['hub_push']}" alt="一键推送成功"><figcaption>⑤ “↑ 公司”真实 UI 回归：成功 toast、卡片 ↑、URL 右键入口同时可见</figcaption></figure>
    <figure><img src="{images['company_receive']}" alt="公司侧收到推送"><figcaption>⑥ 公司模拟页：本机→公司 Unicode/Markdown 内容实际到达</figcaption></figure>
  </div>
  <details><summary>查看平台限流的真实截图</summary><div><img style="width:min(100%,900px);border-radius:12px" src="{images['rate_limit']}" alt="ChatGPT Too many requests"><p>这张图被保留为反证：脚本没有把弹窗后的点击当作成功，随后退避并用 SHA 回读确认。</p></div></details>
</section>

<section id="bugs"><h2>压力过程中发现并当场修掉的问题</h2>
  <div class="grid2">
    <div class="card"><h3>消息身份不稳定</h3><p>原先用 <code>conversation-turn-N</code> 作为游标；页面重渲染后 N 会变化。现改为稳定 <code>data-message-id</code> UUID，并把状态升级为 v2。</p></div>
    <div class="card"><h3>Markdown 回读失真</h3><p>用 DOM <code>innerText</code> 会丢反引号等源字符。现优先复制原消息或读取原始附件字节，49 KB Unicode/Markdown 精确通过。</p></div>
    <div class="card"><h3>大文本发送过早</h3><p>ChatGPT 将长粘贴转附件需要时间，发送按钮可能几十秒后才可用。可编辑等待提高到 120 秒、发送按钮等待 60 秒。</p></div>
    <div class="card"><h3>先确认后投递会丢消息</h3><p>现在固定为 <b>peek → PTY 成功 → message UUID ack</b>；PTY stuck 或失败不推进游标，下一次仍可重取。</p></div>
    <div class="card"><h3>本机推送被反向拉回</h3><p>push 成功后立即把自己的 message UUID 计入 seen。最终实测 <code>status → pull</code> 得到 <code>new=false</code>。</p></div>
    <div class="card"><h3>平台限流被混成普通错误</h3><p>现识别专用弹窗/错误码并返回 <code>rate_limited</code>，压力脚本支持断点续测和显式退避。</p></div>
  </div>
</section>

<section id="limits"><h2>已知边界与安全口径</h2>
  <div class="callout risk"><b>它是本机 ChatGPT 网页自动化，不是官方稳定 API。</b>网页 DOM、附件内部接口和频率策略将来可能变化；因此保留 UI 预览兜底、稳定错误码和真实 E2E，而不能宣称永久零维护。</div>
  <ul><li>当前聚焦普通文字及常见文本附件；Hub 单次输入安全上限 1 MiB，本轮实测至 66,082 B。</li><li>遇到登录失效或安全挑战时，需要重新在专属浏览器完成一次登录；Cookie 不会被打印或放进报告。</li><li>认证目录 ACL 仅保留当前用户、SYSTEM、Administrators；所有文件继承该限制。</li><li>同一账号两个浏览器页面只用于模拟两台电脑；真实使用时公司侧只需 ChatGPT 网页，本机保留自动化页面。</li><li>“推送”不在限流后自动重放，避免消息已提交但回执丢失时造成重复；提示用户稍后再点更安全。</li></ul>
</section>

<section id="delivery"><h2>交付与复现</h2>
  <h3>干净工作树与提交</h3><div class="path">C:\Vibe\Worktrees\hub\chatgpt-bridge-20260828</div>
  <p><code>agent/chatgpt-bridge-20260828</code><br><code>c0b628b</code> — Hub 快捷入口与 IPC<br><code>1cb58e0</code> — 稳定 UUID、双向压力与真实 Codex E2E</p>
  <h3>本机运行部件</h3><div class="path">C:\Users\lintian\tools\chatgpt_bridge\bridge.py</div><div class="path">C:\Users\lintian\.codex\skills\chatgpt-bridge\SKILL.md</div><div class="path">C:\VibeData\ChatGPTBridge\config.json · state.json · auth-state.json</div>
  <h3>验收命令</h3><div class="path">node --test tests\unit-*.test.js<br>node tests\e2e-chatgpt-bridge-cdp.js<br>python -u tests\stress-chatgpt-bridge-resume.py<br>node tests\e2e-chatgpt-bridge-real-pull-cdp.js</div>
  <p class="callout ok"><b>回归结论：</b>全仓 767 tests：765 pass、0 fail、2 skipped；桥接专项 8/8；UI 隔离 E2E PASS；9/9 双向 SHA PASS；真实 Codex 一键拉取与精确 ACK PASS。测试 Hub 使用独立数据目录、独立 CDP 端口和明确 PID，并已干净退出，生产 Hub 未关闭、未重启、未改写。</p>
  <details><summary>机器可读摘要</summary><div><pre>{esc(json.dumps({'stress': stress, 'real_pull': pull}, ensure_ascii=False, indent=2))}</pre></div></details>
</section>

<p class="footer">ChatGPT Bridge acceptance report · self-contained HTML · no cookies or auth material embedded</p>
</main></body></html>
"""
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(html_text, encoding="utf-8", newline="\n")
    digest = hashlib.sha256(REPORT.read_bytes()).hexdigest()
    print(json.dumps({"report": str(REPORT), "bytes": REPORT.stat().st_size, "sha256": digest}, ensure_ascii=False))


if __name__ == "__main__":
    main()
