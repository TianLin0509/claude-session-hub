"""把 WorkMate 的桌宠素材转成 Hub 用的 WebP（2026-10-16）。美术版权归田哥（WorkMate 仓库 RIGHTS.md）。
用法：python -X utf8 scripts/build-hub-pet-assets.py <WorkMate 仓库目录>
输出 renderer/assets/hub-pet/<角色>/：四个姿态单图（idle/typing/happy/sleep，320px）和四段帧序列拼成的 5x5 序列图 seq-*.webp
（typing、idle-life、dock-right、stretch，每格 250px）。帧序列按时间插值播放，见 renderer/hub-pet/pet.js。
WorkMate 只给猫和企鹅画了帧序列；其他角色只有四张单图，由渲染端的连续变换（呼吸、浮动、倾斜）补动作。
manifest.json 记录每个角色实际有哪些序列，渲染端据此选择。"""
import json
import sys
from pathlib import Path
from PIL import Image

src = Path(sys.argv[1]) / 'assets'
out = Path(__file__).resolve().parent.parent / 'renderer' / 'assets' / 'hub-pet'
ROLES = ['01-cat', '03-penguin', '05-rabbit', '07-shiba', '09-hamster', '11-cockatiel']
POSES = ['idle', 'typing', 'happy', 'sleep']
SEQS = ['typing', 'idle-life', 'dock-right', 'stretch']
ANCHOR = {'typing': 'typing', 'idle-life': 'idle', 'dock-right': 'idle', 'stretch': 'idle'}


def load_frame(path):
    """WorkMate 的帧是从整张生成图切出来的，部分帧顶上带着上一格脚底的一条细边；
    顶部 20% 以内、和主体之间隔着透明行的内容一律清掉。"""
    im = Image.open(path).convert('RGBA')
    alpha = im.getchannel('A')
    w, h = im.size
    filled = [alpha.crop((0, y, w, y + 1)).getbbox() is not None for y in range(h)]
    if filled[0]:
        for y in range(1, int(h * 0.2)):
            if not filled[y]:
                im.paste((0, 0, 0, 0), (0, 0, w, y))
                break
    return im
CELL = 250  # 原帧 251px；150% 缩放下显示 225 像素，不用放大
total = 0
manifest = {}
for role in ROLES:
    d = out / role
    d.mkdir(parents=True, exist_ok=True)
    for pose in POSES:
        im = Image.open(src / 'sprites' / role / f'{pose}.png').convert('RGBA')
        im.thumbnail((320, 320), Image.LANCZOS)
        p = d / f'{pose}.webp'
        im.save(p, 'WEBP', quality=86, method=6)
        total += p.stat().st_size
    manifest[role] = {'poses': POSES, 'sequences': []}
    for seq in SEQS:
        frames = sorted((src / 'animations' / role / 'frames' / seq).glob('*.png'))
        stale = d / f'seq-{seq}.webp'
        if len(frames) < 25:
            if stale.exists():
                stale.unlink()
            continue
        manifest[role]['sequences'].append(seq)
        # 帧序列（251px）和单图（512px）的取景不同：同一只猫在帧里更大、脚贴着底边。
        # 按第一帧和对应单图的外框对齐（高度一致、脚底中点重合），换到单图的坐标系里，
        # 这样单图和序列之间交叉淡入时角色不会跳一下。
        anchor = Image.open(src / 'sprites' / role / f'{ANCHOR[seq]}.png').convert('RGBA')
        sb = anchor.getchannel('A').getbbox()
        first = load_frame(frames[0])
        fb = first.getchannel('A').getbbox()
        k = (sb[3] - sb[1]) / (fb[3] - fb[1])
        dx = (sb[0] + sb[2]) / 2 - (fb[0] + fb[2]) / 2 * k
        dy = sb[3] - fb[3] * k
        u = CELL / anchor.width
        sheet = Image.new('RGBA', (CELL * 5, CELL * 5), (0, 0, 0, 0))
        for i, f in enumerate(frames[:25]):
            im = load_frame(f)
            size = max(1, round(im.width * k * u))
            im = im.resize((size, size), Image.LANCZOS)
            cell = Image.new('RGBA', (CELL, CELL), (0, 0, 0, 0))
            cell.paste(im, (round(dx * u), round(dy * u)))  # 空画布上不带蒙版直接贴，透明边缘原样保留
            sheet.alpha_composite(cell, ((i % 5) * CELL, (i // 5) * CELL))
        p = d / f'seq-{seq}.webp'
        sheet.save(p, 'WEBP', quality=82, method=6)
        total += p.stat().st_size
(out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print('written', out, round(total / 1024 / 1024, 2), 'MB')
