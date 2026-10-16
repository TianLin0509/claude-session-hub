"""Actual Hub controls via Playwright/CDP. Synthetic images and localhost only."""
import base64
import hashlib
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

cfg = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
out = Path(cfg['out'])
checks = []
def check(name, **detail):
    checks.append({'check': name, **detail})
    print(name, json.dumps(detail, ensure_ascii=False), flush=True)
def ipc(page, name, arg=None):
    return page.evaluate('(a) => require("electron").ipcRenderer.invoke(a.name, a.arg)', {'name': 'bridge:' + name, 'arg': arg})
def drain():
    for p in [home, company, home]:
        reply = ipc(p, 'check-now')
        assert reply.get('ok'), reply
def images(page):
    return ipc(page, 'status')['images']['items']
def send(page, file, thread, caption, resize=False, expect_error=False):
    panel = page.locator('.bridge-images:visible')
    panel.locator('select[name=thread]').select_option(thread)
    # DOM file selection preserves Electron's native path; Playwright's remote
    # payload upload constructs an in-memory File with no local path.
    cdp = page.context.new_cdp_session(page)
    doc = cdp.send('DOM.getDocument')
    node = cdp.send('DOM.querySelector', {'nodeId': doc['root']['nodeId'], 'selector': '.bridge-images input[name=file]'})
    cdp.send('DOM.setFileInputFiles', {'nodeId': node['nodeId'], 'files': [str(Path(file).resolve())]})
    cdp.detach()
    assert panel.locator('input[name=file]').evaluate('(e) => !!require("electron").webUtils.getPathForFile(e.files[0])')
    panel.locator('input[name=caption]').fill(caption)
    panel.locator('input[name=resize]').set_checked(resize)
    start = time.monotonic()
    panel.get_by_role('button', name='发送图片文字消息').click()
    panel.locator('.bi-result').filter(has_text='正在').wait_for(state='hidden', timeout=60000)
    message = panel.locator('.bi-result').inner_text()
    if expect_error:
        assert '无法满足' in message, message
        return {'message': message, 'seconds': round(time.monotonic()-start, 3)}
    assert '完整文字' in message, message
    item = next(x for x in images(page) if x['caption'] == caption)
    assert item['textBytes'] < 60000
    return {**item, 'seconds': round(time.monotonic()-start, 3)}
def verify_received(sender, receiver, item):
    drain()
    received = next(x for x in images(receiver) if x['id'] == item['id'])
    original = Path(item['path']).read_bytes()
    restored = Path(received['path']).read_bytes()
    assert original == restored
    assert hashlib.sha256(restored).hexdigest() == item['sha256']
    assert next(x for x in images(sender) if x['id'] == item['id'])['state'] == 'received'
    panel = receiver.locator(f'.bi-item[data-image-id="{item["id"]}"]')
    panel.locator('summary').click()
    panel.locator('img').wait_for(state='visible')
    assert panel.locator('img').evaluate('(e) => e.complete && e.naturalWidth > 0')
    check(item['caption'], textBytes=item['textBytes'], imageBytes=item['imageBytes'], width=item['width'], height=item['height'], lossy=item['lossy'], resized=item['resized'], seconds=item['seconds'], identical=True)

with sync_playwright() as pw:
    hb = pw.chromium.connect_over_cdp(cfg['home'])
    cb = pw.chromium.connect_over_cdp(cfg['company'])
    home = next(p for p in hb.contexts[0].pages if p.url.endswith('index.html'))
    company = next(p for p in cb.contexts[0].pages if p.url.endswith('index.html'))
    for page in [home, company]:
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.wait_for_function('typeof window.__hubOpenSession === "function"', timeout=60000)
    drain()
    assert ipc(home, 'status')['images']['peerSupported']
    assert ipc(company, 'status')['images']['peerSupported']
    if not home.locator('#btn-wireless').is_visible():
        home.locator('#btn-toggle-navigation').click()
    home.locator('#btn-wireless').click()
    home.locator('.cl-section .bridge-images').wait_for(state='visible')
    company.locator('#btn-options').click()
    company.locator('#options-home-link').click()
    company.locator('.bridge-images').wait_for(state='visible')
    check('两端真实 Hub 的图片入口可操作；能力协商成功')
    first = send(company, cfg['sample'], 'Q-1017-01', '公司到家里：合成噪声图')
    assert first['textBytes'] > 20000
    verify_received(company, home, first)
    home.locator('.bridge-images').scroll_into_view_if_needed()
    home.screenshot(path=str(out / 'home-restored.png'))
    # Canvas diagram is generated in this isolated renderer, without any image source.
    chart = home.evaluate('''() => {
      const c=document.createElement('canvas'); c.width=1440; c.height=900; const x=c.getContext('2d');
      x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.fillStyle='#182a45';x.font='bold 38px Microsoft YaHei';
      x.fillText('合成测试图：吞吐率随负载变化',65,78);x.font='22px Microsoft YaHei';x.fillStyle='#556478';
      x.fillText('仅为图片通道验证生成，不含任何公司数据',65,122);
      for(let i=0;i<9;i++){let y=205+i*65;x.strokeStyle='#dce3ec';x.beginPath();x.moveTo(95,y);x.lineTo(1340,y);x.stroke();x.fillText(String(800-i*100),35,y+7);}
      x.fillText('吞吐率 / Mbps',95,180);x.fillText('负载 / %',1220,840);
      for(let s=0;s<3;s++){x.strokeStyle=['#3478f6','#22a17d','#cb7045'][s];x.lineWidth=4;x.beginPath();for(let i=0;i<=100;i++){let px=95+i*12.4,py=720-(1-Math.exp(-i/(25+s*15)))*(480-s*90);i?x.lineTo(px,py):x.moveTo(px,py);}x.stroke();}
      x.fillStyle='#182a45';x.font='24px Microsoft YaHei';x.fillText('图例：方案 A / 方案 B / 方案 C',760,170);
      x.font='18px Microsoft YaHei';for(let i=0;i<11;i++)x.fillText(String(i*10),90+i*124,780);
      return {png:c.toDataURL('image/png').split(',')[1], jpeg:c.toDataURL('image/jpeg',.9).split(',')[1]};
    }''')
    chart_path = out / 'synthetic-chart.png'; chart_path.write_bytes(base64.b64decode(chart['png']))
    jpeg_path = out / 'synthetic-chart.jpeg'; jpeg_path.write_bytes(base64.b64decode(chart['jpeg']))
    second = send(home, str(chart_path), 'H-1017-01', '家里到公司：合成中文曲线图')
    verify_received(home, company, second)
    assert second['width'] == 1440 and second['height'] == 900 and not second['resized']
    company.locator('.bridge-images').scroll_into_view_if_needed()
    company.screenshot(path=str(out / 'company-chart.png'))
    before = len(images(home))
    rejected = send(home, cfg['dense'], 'Q-1017-01', '过大合成图默认不缩放', expect_error=True)
    assert len(images(home)) == before
    assert home.locator('.bridge-images input[name=file]').evaluate('(e) => e.files.length') == 1
    check('压不下时明确失败、保留选图、没有发送', **rejected)
    third = send(home, cfg['dense'], 'Q-1017-01', '明确允许缩小的合成图', resize=True)
    assert third['resized']
    verify_received(home, company, third)
    # A second image in the opposite H thread verifies both thread families both ways.
    fourth = send(company, str(chart_path), 'H-1017-01', '公司到家里：H 线程附图')
    verify_received(company, home, fourth)
    fifth = send(company, str(jpeg_path), 'Q-1017-01', 'JPEG 输入：合成中文曲线图')
    verify_received(company, home, fifth)
    assert fifth['width'] == 1440 and fifth['height'] == 900 and not fifth['resized']
    # Receiving a current ACK must update the form status as well as the history.
    assert '已接收并校验' in company.locator('.bi-result').inner_text()
    company.locator('.bridge-images').scroll_into_view_if_needed()
    company.screenshot(path=str(out / 'company-final.png'))
    home.locator('.bridge-images').scroll_into_view_if_needed()
    home.screenshot(path=str(out / 'home-final.png'))
    for name, page in [('home', home), ('company', company)]:
        (out / (name+'-status.json')).write_text(json.dumps(ipc(page,'status'),ensure_ascii=False,indent=2),encoding='utf-8')
    (out / 'ui-results.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf-8')
