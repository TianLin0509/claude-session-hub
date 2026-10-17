"""把 WorkMate 的桌宠素材转成 Hub 用的 WebP（2026-10-16，2026-10-17 重做对齐）。美术版权归田哥（WorkMate 仓库 RIGHTS.md）。
用法：python -X utf8 scripts/build-hub-pet-assets.py <WorkMate 仓库目录>
输出 renderer/assets/hub-pet/<角色>/：四个姿态单图（idle/typing/happy/sleep，320px）和四段帧序列拼成的 5x5 序列图 seq-*.webp
（typing、idle-life、dock-right、stretch，每格 250px）。播放规则见 renderer/hub-pet/pet.js。
WorkMate 只给猫和企鹅画了帧序列；其他角色只有四张单图，由渲染端的连续变换（呼吸、浮动、倾斜）补动作。

2026-10-17 田哥反馈「动起来有残影、看花眼」。量下来帧序列本身有三个问题，这里在出图时一次处理掉：
1. 落点漂移：AI 分镜里同一只猫每一行比上一行整体往上偏 5–75px（企鹅 idle-life 最后两行头顶被切）。
   原来只按第一帧对齐整段，后面的帧越播越往上飘。现在逐帧找「脚底」——主体最底部 8% 的加权中心
   （借鉴 WorkMate 的 AlignToGroundAnchor）——全部对到同一个点：idle 单图的脚底。
2. 串格：切格时把相邻格的手、头顶切进来（例如企鹅 idle-life 第 17 帧底部的一只手）。
   碰到格子上下边、又不是主体的小块一律清掉。
3. 裁切：头顶被格子边切掉的帧不能播。按「顶边一行有多少不透明像素」判定，写进 manifest 的 clipped，
   渲染端挑片段时跳过。
四张单图也按同一个脚底对齐，换姿态时角色站在同一个位置，不会上下跳。"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

src = Path(sys.argv[1]) / 'assets'
out = Path(__file__).resolve().parent.parent / 'renderer' / 'assets' / 'hub-pet'
ROLES = ['01-cat', '03-penguin', '05-rabbit', '07-shiba', '09-hamster', '11-cockatiel']
POSES = ['idle', 'typing', 'happy', 'sleep']
SEQS = ['typing', 'idle-life', 'dock-right', 'stretch']
CELL = 250   # 原帧 251px；150% 缩放下显示 225 像素，不用放大
STILL = 320
ALPHA_ON = 12
CLIP_TOP_RATIO = 0.04  # 顶边一行有超过 4% 宽度是不透明的，算头被切掉


def ground_anchor(alpha):
    """脚底：最底下一行不透明像素往上 8% 高度这一条里，按透明度加权的横向中心。返回 (x, y)。"""
    on = alpha >= ALPHA_ON
    rows = np.where(on.any(axis=1))[0]
    if not len(rows):
        return None
    bottom = rows[-1]
    top = max(0, bottom - max(4, round(alpha.shape[0] * 0.08)))
    band = alpha[top:bottom + 1].astype(np.float64)
    xs = np.arange(alpha.shape[1])
    w = band.sum()
    return ((band.sum(axis=0) * xs).sum() / w if w else alpha.shape[1] / 2, float(bottom))


def clean_frame(im):
    """去掉串格进来的碎片：只保留主体，以及不碰格子上下边的其他小块（比如飘起来的小星星）。"""
    a = np.array(im.getchannel('A'))
    labels, n = ndimage.label(a >= ALPHA_ON)
    if n <= 1:
        return im
    sizes = ndimage.sum(np.ones_like(a), labels, index=range(1, n + 1))
    main = int(np.argmax(sizes)) + 1
    h = a.shape[0]
    drop = np.zeros_like(a, dtype=bool)
    for k in range(1, n + 1):
        if k == main:
            continue
        ys = np.where((labels == k).any(axis=1))[0]
        touches_edge = ys[0] <= 1 or ys[-1] >= h - 2
        if touches_edge or sizes[k - 1] < sizes[main - 1] * 0.002:
            drop |= labels == k
    if drop.any():
        # 主体边缘半透明的抗锯齿像素也属于碎片时一并清掉（膨胀 1 像素）
        drop = ndimage.binary_dilation(drop, iterations=1) & (labels != main)
        rgba = np.array(im)
        rgba[drop] = 0
        im = Image.fromarray(rgba, 'RGBA')
    return im


def is_clipped(im):
    a = np.array(im.getchannel('A'))
    return float((a[0] >= ALPHA_ON).mean()) > CLIP_TOP_RATIO


def shift_into(im, dx, dy, size):
    """把 im 贴到 size×size 的透明画布上，偏移 (dx, dy)；偏移量收紧到不切掉主体的范围。"""
    a = np.array(im.getchannel('A'))
    on = a >= ALPHA_ON
    ys, xs = np.where(on.any(axis=1))[0], np.where(on.any(axis=0))[0]
    dx = int(round(max(-xs[0], min(size - 1 - xs[-1], dx))))
    dy = int(round(max(-ys[0], min(size - 1 - ys[-1], dy))))
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(im, (dx, dy))
    return canvas


total = 0
manifest = {}
for role in ROLES:
    d = out / role
    d.mkdir(parents=True, exist_ok=True)
    # 单图：先缩到 320，再按 idle 的脚底对齐。
    stills = {}
    for pose in POSES:
        im = Image.open(src / 'sprites' / role / f'{pose}.png').convert('RGBA')
        im.thumbnail((STILL, STILL), Image.LANCZOS)
        stills[pose] = im
    ax, ay = ground_anchor(np.array(stills['idle'].getchannel('A')))
    for pose, im in stills.items():
        px, py = ground_anchor(np.array(im.getchannel('A')))
        aligned = shift_into(im, ax - px, ay - py, STILL) if pose != 'idle' else im
        p = d / f'{pose}.webp'
        aligned.save(p, 'WEBP', quality=86, method=6)
        total += p.stat().st_size
    idle_alpha = np.array(stills['idle'].getchannel('A'))
    on = idle_alpha >= ALPHA_ON
    idle_h = np.where(on.any(axis=1))[0]
    idle_height = idle_h[-1] - idle_h[0]
    manifest[role] = {'poses': POSES, 'sequences': [], 'clipped': {}}
    u = CELL / STILL
    for seq in SEQS:
        frames = sorted((src / 'animations' / role / 'frames' / seq).glob('*.png'))
        stale = d / f'seq-{seq}.webp'
        if len(frames) < 25:
            if stale.exists():
                stale.unlink()
            continue
        manifest[role]['sequences'].append(seq)
        raw = [Image.open(f).convert('RGBA') for f in frames[:25]]
        clipped = [i for i, im in enumerate(raw) if is_clipped(im)]
        cleaned = [clean_frame(im) for im in raw]
        # 整段一个缩放：第一帧主体高度 = idle 单图主体高度（同一只猫在帧里画得更大）。
        fa = np.array(cleaned[0].getchannel('A')) >= ALPHA_ON
        fr = np.where(fa.any(axis=1))[0]
        k = idle_height / (fr[-1] - fr[0]) * u
        target = (ax * u, ay * u)
        sheet = Image.new('RGBA', (CELL * 5, CELL * 5), (0, 0, 0, 0))
        for i, im in enumerate(cleaned):
            size = max(1, round(im.width * k))
            small = im.resize((size, size), Image.LANCZOS)
            gx, gy = ground_anchor(np.array(small.getchannel('A')))
            cell = shift_into(small, target[0] - gx, target[1] - gy, CELL)
            sheet.alpha_composite(cell, ((i % 5) * CELL, (i // 5) * CELL))
        p = d / f'seq-{seq}.webp'
        sheet.save(p, 'WEBP', quality=82, method=6)
        total += p.stat().st_size
        if clipped:
            manifest[role]['clipped'][seq] = clipped
    if not manifest[role]['clipped']:
        del manifest[role]['clipped']
(out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
print('written', out, round(total / 1024 / 1024, 2), 'MB')
print(json.dumps({r: v.get('clipped', {}) for r, v in manifest.items()}, ensure_ascii=False))
