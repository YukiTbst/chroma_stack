from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Rectangle
from matplotlib.collections import PolyCollection

out = Path(r'D:\3d models\HybridColorPrint\app\previews\multicolor-td-matrix-preview.png')
font_path = r'C:\Windows\Fonts\msyh.ttc'
font_manager.fontManager.addfont(font_path)
plt.rcParams.update({'font.family': font_manager.FontProperties(fname=font_path).get_name(), 'axes.unicode_minus': False})

filaments = {
    'W': {'name': '白', 'hex': '#ffffff', 'hd': 0.50},
    'K': {'name': '黑', 'hex': '#000000', 'hd': 0.30},
    'R': {'name': '红', 'hex': '#c00d1e', 'hd': 0.70},
    'U': {'name': '蓝', 'hex': '#00358e', 'hd': 1.10},
}
# Every cell has two base layers, followed by one to three colour layers.
# K/W are the two effective photographic substrates; U is used for blue.
mix_left = [['W', 'R'], ['R', 'W'], ['W', 'U'], ['U', 'W'], ['R', 'U', 'R'], ['U', 'R', 'U']]
mix_right = [['K', 'R'], ['R', 'K'], ['K', 'U'], ['U', 'K'], ['R', 'W', 'R'], ['U', 'W', 'U']]
cells = []
for side in range(2):
    base = 'K' if side == 0 else 'W'
    recipes = []
    for f in ['W', 'K', 'R', 'U']:
        for n in (1, 2, 3):
            recipes.append((f, [f] * n, f'{filaments[f]["name"]}·{n}'))
    mixes = mix_left if side == 0 else mix_right
    recipes.extend(('M', recipe, '→'.join(filaments[f]['name'] for f in recipe)) for recipe in mixes)
    for row in range(6):
        for col in range(3):
            kind, recipe, label = recipes[row * 3 + col]
            x = 9 + (side * 3 + col) * 14
            y = 9 + row * 14
            cells.append({'x': x, 'y': y, 'size': 12, 'base': base, 'recipe': recipe, 'label': label, 'kind': kind, 'side': side})


def rgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float)


def lin(v):
    v = np.asarray(v) / 255
    return np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)


def srgb(v):
    v = np.clip(v, 0, 1)
    return np.round(255 * np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)).astype(int)


def predicted(cell):
    color = lin(rgb(filaments[cell['base']]['hex']))
    for f in cell['recipe']:
        T = 10 ** (-0.08 / filaments[f]['hd'])
        color = lin(rgb(filaments[f]['hex'])) * (1 - T) + color * T
    return srgb(color)


def css(a):
    return '#' + ''.join(f'{int(v):02x}' for v in a)


def text_color(a):
    return '#15252c' if np.mean(a) > 145 else '#f4fbff'


fig = plt.figure(figsize=(15, 10.8), dpi=160, facecolor='#f3f5f7')
gs = fig.add_gridspec(2, 2, height_ratios=[3.35, 1.15], width_ratios=[1.23, 1], hspace=0.17, wspace=0.055,
                      left=0.035, right=0.975, top=0.875, bottom=0.065)
fig.text(0.045, 0.955, '叠彩 · 5 层多色 TD 矩阵', fontsize=25, fontweight='bold', color='#14232b')
fig.text(0.047, 0.918, '概念设计预览  ·  100 × 100 × 0.40 mm  ·  36 格  ·  24 个单色厚度格 + 12 个跨色组合格',
         fontsize=13.2, color='#49616e')


# Conceptual solid geometry: two base layers and at most three colour layers.
def quad_box(x0, y0, z0, x1, y1, z1, top=True, bottom=False):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    faces = [[v[i] for i in f] for f in [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]]
    if top:
        faces.append([v[i] for i in (4, 5, 6, 7)])
    if bottom:
        faces.append([v[i] for i in (0, 3, 2, 1)])
    return faces


def scale_faces(faces, scale):
    return [[(x, y, z * scale) for x, y, z in face] for face in faces]


ax = fig.add_subplot(gs[0, 0])
ax.set_facecolor('#f3f5f7')
zs = 30
render_faces = []
for x0, x1, f in [(0, 50, 'K'), (50, 100, 'W')]:
    for face in quad_box(x0, 0, 0, x1, 100, 0.16, bottom=True):
        render_faces.append((face, f))
for cell in cells:
    z = 0.16
    for j, f in enumerate(cell['recipe']):
        for face in quad_box(cell['x'], cell['y'], z, cell['x'] + 12, cell['y'] + 12, z + 0.08, top=j == len(cell['recipe']) - 1):
            render_faces.append((face, f))
        z += 0.08
# Two-layer high-contrast markers stay within the five-layer height cap.
for x, y, f in [(2, 2, 'W'), (94, 2, 'K'), (94, 94, 'K'), (2, 94, 'W')]:
    for face in quad_box(x, y, 0.16, x + 4, y + 4, 0.32):
        render_faces.append((face, f))
# Orthographic isometric projection with a global far-to-near face sort.
# This avoids mplot3d hiding small raised cells behind a large base polygon.
projected = []
for face, f in render_faces:
    scaled = np.array([(x, y, z * zs) for x, y, z in face])
    points = [(0.8660254 * (x - y), 0.50 * (x + y) - zz) for x, y, zz in scaled]
    depth = float(np.mean(np.sum(scaled, axis=1)))
    original = np.asarray(face)
    normal = np.cross(original[1] - original[0], original[2] - original[0])
    normal = normal / max(1e-9, np.linalg.norm(normal))
    light = max(0.0, float(np.dot(normal, np.array([-0.35, -0.45, 0.82]))))
    shade = 0.76 + 0.24 * light
    color = np.clip(rgb(filaments[f]['hex']) / 255 * shade, 0, 1)
    projected.append((depth, points, color))
projected.sort(key=lambda item: item[0])
ax.add_collection(PolyCollection([p for _, p, _ in projected], facecolors=[c for _, _, c in projected],
                                 edgecolors='#43565f', linewidths=0.10))
all_points = np.array([p for _, face, _ in projected for p in face])
ax.set_xlim(all_points[:, 0].min() - 5, all_points[:, 0].max() + 5)
ax.set_ylim(all_points[:, 1].min() - 5, all_points[:, 1].max() + 5)
ax.set_aspect('equal')
ax.axis('off')
ax.set_title('三维材料结构（设计模型）', fontsize=16, fontweight='bold', color='#1f343e', pad=8)
ax.text(0.02, 0.015, 'Z 方向 ×30；实际最高仅 0.40 mm\n每个色格独立配方，同一 Z 层可有多种耗材',
        transform=ax.transAxes, fontsize=10.2, color='#687d87')

# Top-view optical prediction.
ax2 = fig.add_subplot(gs[0, 1])
ax2.set_aspect('equal')
ax2.set_facecolor('#f3f5f7')
ax2.add_patch(Rectangle((0, 0), 50, 100, facecolor='#000000', edgecolor='none'))
ax2.add_patch(Rectangle((50, 0), 50, 100, facecolor='#ffffff', edgecolor='none'))
ax2.add_patch(Rectangle((0, 0), 100, 100, facecolor='none', edgecolor='#34464f', lw=1.2))
for cell in cells:
    color = predicted(cell)
    ax2.add_patch(Rectangle((cell['x'], cell['y']), 12, 12, facecolor=css(color), edgecolor='#74878f', lw=0.38))
    ax2.plot(cell['x'] + 6, cell['y'] + 6, marker='o', ms=2.7, mfc='none', mec='#32e398', mew=0.85)
    ax2.text(cell['x'] + 6, cell['y'] + 6.3, cell['label'], ha='center', va='center',
             fontsize=7.2 if cell['kind'] == 'M' else 8.3, color=text_color(color),
             fontweight='bold' if cell['kind'] != 'M' else 'normal')
for x, y, f in [(2, 2, 'W'), (94, 2, 'K'), (94, 94, 'K'), (2, 94, 'W')]:
    ax2.add_patch(Rectangle((x, y), 4, 4, facecolor=filaments[f]['hex'], edgecolor='#78a393', lw=0.6))
    ax2.plot(x + 2, y + 2, marker='o', ms=5, mfc='none', mec='#32e398', mew=1.1)
ax2.plot([0, 100], [63, 63], color='#e4a04b', lw=1.1, ls='--', alpha=0.9)
ax2.text(25, -1.7, '黑底参考区', ha='center', fontsize=10.5, color='#344b56', fontweight='bold')
ax2.text(75, -1.7, '白底参考区', ha='center', fontsize=10.5, color='#344b56', fontweight='bold')
ax2.text(50, 63, '跨色组合（下两行）', ha='center', va='center', fontsize=7.8, color='#9b6324',
         bbox={'facecolor': '#f3f5f7', 'edgecolor': 'none', 'pad': 1.2, 'alpha': 0.85})
ax2.set_xlim(-3, 103)
ax2.set_ylim(103, -5)
ax2.axis('off')
ax2.set_title('俯视照片预期（HD 模型模拟）', fontsize=16, fontweight='bold', color='#1f343e', pad=8)
ax2.text(0.5, -0.015, '白·1/2/3 = 白色叠 1/2/3 层；箭头 = 从下到上的材料顺序\n绿圈 = 取色点；四角 = 高对比定位标记',
         transform=ax2.transAxes, ha='center', fontsize=9.1, color='#687d87')

# Five explicit global material layers.
bottom = gs[1, :].subgridspec(1, 5, wspace=0.10)
for layer in range(1, 6):
    a = fig.add_subplot(bottom[0, layer - 1])
    a.set_aspect('equal')
    a.set_facecolor('#f3f5f7')
    active = set()
    if layer <= 2:
        a.add_patch(Rectangle((0, 0), 50, 100, facecolor='#000000'))
        a.add_patch(Rectangle((50, 0), 50, 100, facecolor='#ffffff'))
        active = {'K', 'W'}
    else:
        for cell in cells:
            idx = layer - 3
            if idx < len(cell['recipe']):
                f = cell['recipe'][idx]
                active.add(f)
                a.add_patch(Rectangle((cell['x'], cell['y']), 12, 12, facecolor=filaments[f]['hex'], edgecolor='#71828a', lw=0.25))
        if layer in (3, 4):
            for x, y, f in [(2, 2, 'W'), (94, 2, 'K'), (94, 94, 'K'), (2, 94, 'W')]:
                a.add_patch(Rectangle((x, y), 4, 4, facecolor=filaments[f]['hex'], edgecolor='#71828a', lw=0.25))
    a.add_patch(Rectangle((0, 0), 100, 100, facecolor='none', edgecolor='#40545e', lw=0.8))
    a.set_xlim(-2, 102)
    a.set_ylim(102, -2)
    a.axis('off')
    a.set_title(f'L{layer} · {len(active)} 色', fontsize=11.5, fontweight='bold', color='#263d48', pad=4)
    a.text(50, 107, '基底' if layer <= 2 else ('首层颜色' if layer == 3 else '后续叠色'), ha='center', fontsize=8.3, color='#6b7f89')
fig.text(0.047, 0.025, '空白格 = 该层不再加料。单色厚度格用于反解 HD→TD；跨色格用于验证材料顺序与相互作用。效果图不是实拍，版式尚未加入应用。',
         fontsize=10.5, color='#415b68')
fig.savefig(out, facecolor=fig.get_facecolor(), bbox_inches='tight')
print(out)
print('cells', len(cells), 'max layers', 2 + max(len(c['recipe']) for c in cells))
