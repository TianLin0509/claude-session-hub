from pathlib import Path
import base64
import hashlib
import html
import json

here = Path(__file__).resolve().parent
root = here.parent.parent

def read(p):
    data = p.read_bytes()
    return data.decode('utf-16' if data.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig').replace('\r', '')

unit = read(here / 'T5-unit-all-final2.log')
e2e = read(here / 'T5-e2e-final.log')
assert '全部通过：403 个文件' in unit
assert all('T5 real Hub scenario OK: ' + s in e2e for s in ['ring', 'low-balance', 'stale', 'empty'])
assert '"ok": true' in e2e  # original weekly-only/background-cache regression

files = ['renderer/account-usage-controller.js', 'renderer/index.html', 'renderer/styles/rail.css',
         'renderer/styles/account-config-preview.css', 'tests/unit-account-usage-controller-contract.test.js',
         'tests/e2e-usage-refresh-cdp.js']
# Git normalizes working-tree CRLF on add. Hash normalized text to keep this
# identity stable before and after checkout, without embedding a circular commit ID.
hashes = {f: hashlib.sha256((root / f).read_bytes().replace(b'\r\n', b'\n')).hexdigest() for f in files}
before = json.loads(read(here / 'T5-geometry-baseline.json'))
after = json.loads(read(here / 'T5-geometry-after.json'))
assert after['terminal']['height'] - before['terminal']['height'] == 30
manifest = {'baseline': '96b751d1c02181635bb64e5b5cff61707b8d29d1',
            'branch': 'feat/frost-usage-ring-20260909-codex1', 'normalizedSourceSha256': hashes,
            'unitFiles': 403, 'e2eScenarios': 5, 'themes': 6, 'geometry': {'before': before, 'after': after}}
(here / 'T5-verification-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

def detail(title, text):
    return '<details><summary>' + html.escape(title) + '</summary><pre>' + html.escape(text) + '</pre></details>'

out = '''<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>T5 用量环实施报告 · 待独立评审</title><style>
body{font:15px/1.65 'Segoe UI','Microsoft YaHei',sans-serif;background:#10151d;color:#e8edf5;margin:0;padding:32px}
main{max-width:1100px;margin:auto}h1{font-size:27px}h2{font-size:19px;color:#c6d4ff}.cards{display:flex;flex-wrap:wrap;gap:12px}.cards p{flex:1;min-width:160px;background:#1b2432;border:1px solid #344258;padding:18px;border-radius:12px}.cards b{display:block;font-size:27px;color:#97b3ff}section,details{margin:20px 0;padding:18px;border:1px solid #303c50;border-radius:12px}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}img{width:100%;height:auto;border-radius:8px}code{overflow-wrap:anywhere;color:#b7ccff}.tag{color:#fbbf24}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-bottom:1px solid #303c50;padding:8px}</style></head><body><main>
<h1>T5：用量环已迁入 rail</h1><p class="tag">执行者自验完成，等待独立评审；本报告不是合并 PASS。</p>
<p>顶部 30px 用量条退出布局；rail 常驻最紧窗口，悬停或点击查看三家明细。主页、采集与缓存后端保持原有分工。</p>
<div class="cards"><p><b>403 / 403</b>全量单测文件通过</p><p><b>5 个场景</b>真实隔离 Hub + CDP</p><p><b>+30px</b>终端可用高度 680 → 710</p><p><b>6 套主题</b>真实切换与截图检查</p></div>
<section><h2>行为与取舍</h2><p>四个窗口按原始百分比取最大，60～85 为 warn，超过 85 为 danger；主页原有颜色函数不变。DeepSeek 低余额以内部 warn 分数参与，但环内显示 !、明细显示真实余额。环的新鲜度取获选提供商，弹层底行取三家最旧已知观测，两者都有说明。</p><p>按钮和弹层操作节点只创建一次，数据更新不丢焦点。刷新失败、后端降级显示在弹层；新提示改变高度时保持顶边稳定。旧顶部节点留一版但永久隐藏；仅删除已批准的死节点及专属 CSS。</p></section>
<section><h2>实际验证边界</h2><table><tr><th>场景</th><th>通过条件</th></tr>
<tr><td>原刷新回归</td><td>周窗口正确标成 7d、缺失 5h 为 —、后台旧 JSONL 不覆盖实时值、Claude 101% 保留</td></tr>
<tr><td>88% Codex</td><td>红环、刷新后 66% warn、防重复刷新、错误反馈、焦点保留、键盘、备忘录、主页、侧栏折叠与窄窗口</td></tr>
<tr><td>低余额 / 过期 / 无数据</td><td>分别为 ! 告警、虚线灰环保留 88%、— 与未刷新</td></tr>
<tr><td>几何</td><td>1280×900 相同视口与实际 PowerShell 会话，顶部条 30 → 0，终端 680 → 710</td></tr>
</table><p>UI 使用测试数据目录、隔离 HOME、独立 CDP/PID；get-meetings 返回空数组，hook server 正常监听。提供商返回是受控 app-server / JSONL / 余额缓存 fixture，验证真实 Hub 数据与交互链路，不代表真实账号联网采集测试。120 秒边界由可控时钟单测验证，真实 Hub 另验陈旧缓存灰环。</p></section>
<section><h2>命令</h2><pre>node --check renderer/account-usage-controller.js
node --check tests/e2e-usage-refresh-cdp.js
node tests/unit-account-usage-controller-contract.test.js
node tests/unit-scene-rail-dom-contract.test.js
node tests/unit-hub-version-sync.test.js
node tests/unit-file-manager-ui-contract.test.js
node tests/e2e-usage-refresh-cdp.js
node artifacts/20260907-frost-v2/T5-geometry.cjs baseline
node artifacts/20260907-frost-v2/T5-geometry.cjs after
$env:PATH = 'C:\\Program Files\\Git\\bin;' + $env:PATH
node scripts/run_unit_tests.js
git diff --check</pre><p>最终上述检查均退出 0。baseline 几何在改产品代码前采集，不是在成品 DOM 上重新显示 ticker 来模拟。PATH 只调整验证子进程，不改全局环境。</p></section>
<section><h2>失败记录与处置</h2><p>选窗单测先因未导出函数失败，随后实现。首次全量检查暴露备忘录入口的既有静态契约以及找不到 sh：保留真实的静态按钮模板，并在验证进程 PATH 加入已安装的 Git bin 后通过，未改无关测试。CDP Enter 缺字符事件导致一次键盘测试假失败，补齐输入后正常。过期数据的弹层更新暴露了 hover 位移，保持顶边并复测五场景通过。失败日志保留在本工作树 T5 产物中。</p></section>
<section><h2>审查与回退</h2><p>仅 4 个产品文件、2 个测试文件及本卡证据。没有改另一车道、版本号或依赖；主目录两处原有脏改动保留。实际候选完整 SHA 见阶段协作手册；这里以基线与源码 SHA-256 标识亲验内容，避免报告包含自己的提交号产生循环。</p><p>审查位基于最新主干亲跑 merge_task.py --dry-run，再独立验 UI。未运行正式合并。若退回，保留工作树、提交与证据，仅修 BLOCKERS；回退 T5 功能提交即可恢复顶部呈现，不需数据迁移。</p></section>
'''
for name, title in [('T5-rail-usage-ring.png', '88% Codex 环与顶部空间'), ('T5-usage-popover.png', '三家明细与动作')]:
    out += '<section><h2>' + title + '</h2><img alt="' + title + '" src="data:image/png;base64,' + base64.b64encode((here / name).read_bytes()).decode() + '"></section>'
out += detail('最终全量单测日志', unit)
out += detail('最终 E2E 日志', e2e)
out += detail('基线、源码指纹与几何记录', json.dumps(manifest, ensure_ascii=False, indent=2))
out += '</main></body></html>'
(here / 'T5-report.html').write_text(out, encoding='utf-8')
print('T5 report written; source files:', len(hashes))
