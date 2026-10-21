# 生成 welink-login-qr.json（2026-10-22，v3.1.1 二维码修复）：用 segno（标准 QR 编码器）离线把替身的 qrcode_content
# 编成真实二维码矩阵，写死进 fixture；测试和 welink-cli 替身都只读这个 JSON，不在运行时依赖任何二维码库。
# 重新生成：python -I tests/fixtures/make-welink-qr-fixture.py
import json, os, segno

CONTENT = 'welink://qrlogin?uuid=standin-6f1c2a9e-20261022'
URL = 'https://welink.standin.invalid/qrcode/login?uuid=standin-6f1c2a9e-20261022'

qr = segno.make(CONTENT, error='m', micro=False)
rows = [''.join('1' if v else '0' for v in row) for row in qr.matrix_iter(scale=1, border=0)]
out = {
    '$comment': '由 make-welink-qr-fixture.py 用 segno %s 生成；rows 不含静区，1=黑模块。' % segno.__version__,
    'content': CONTENT,
    'url': URL,
    'version': qr.version,
    'error': qr.error,
    'size': len(rows),
    'rows': rows,
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'welink-login-qr.json')
with open(path, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write('\n')
print(path, qr.version, qr.error, len(rows))
