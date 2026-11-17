"""Generate the physical 75 mm four-filament TD matrix used for A1-mini printing.
The Z edges explicitly encode a 0.24 mm first layer and 0.08 mm later layers.
"""
from pathlib import Path
import json
import zipfile
from xml.sax.saxutils import escape

OUT = Path(r'D:\3d models\HybridColorPrint\tests\ChromaStack_TD_Matrix_75mm_L12.3mf')
BOARD = 75.0
FIRST_LAYER = 0.24
LAYER = 0.08
BASE_LAYERS = 2
BASE_HEIGHT = FIRST_LAYER + LAYER
SINGLE_STEPS = [1, 4, 10]
TOTAL_LAYERS = BASE_LAYERS + max(SINGLE_STEPS)
MAX_HEIGHT = FIRST_LAYER + (TOTAL_LAYERS - 1) * LAYER
Z_EDGES = [0.0, FIRST_LAYER] + [round(FIRST_LAYER + i * LAYER, 4) for i in range(1, TOTAL_LAYERS)]

# Actual AMS slots read from the A1 mini device page: 1 black, 2 white, 3 red, 4 blue.
PALETTE = [
    {'code': 'K', 'name': 'Black', 'hex': '#000000', 'hd': 0.30, 'ams': 1},
    {'code': 'W', 'name': 'White', 'hex': '#ffffff', 'hd': 0.50, 'ams': 2},
    {'code': 'R', 'name': 'Red', 'hex': '#c00d1e', 'hd': 0.70, 'ams': 3},
    {'code': 'U', 'name': 'Blue', 'hex': '#00358e', 'hd': 1.10, 'ams': 4},
]
INDEX = {p['code']: i for i, p in enumerate(PALETTE)}


def add_box(objects, material, x0, y0, z0, x1, y1, z1):
    pos = objects[material]['pos']
    idx = objects[material]['idx']
    # Geometry is centred for Bambu Studio; metadata remains in 0..75 mm coordinates.
    x0 -= BOARD / 2
    x1 -= BOARD / 2
    y0 -= BOARD / 2
    y1 -= BOARD / 2
    base = len(pos) // 3
    vertices = [
        (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
        (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
    ]
    for v in vertices:
        pos.extend(v)
    faces = [
        (0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
        (0, 1, 5), (0, 5, 4), (3, 7, 6), (3, 6, 2),
        (0, 4, 7), (0, 7, 3), (1, 2, 6), (1, 6, 5),
    ]
    for a, b, c in faces:
        idx.extend((base + a, base + b, base + c))


objects = {p['code']: {'pos': [], 'idx': []} for p in PALETTE}
add_box(objects, 'K', 0, 0, 0, BOARD / 2, BOARD, BASE_HEIGHT)
add_box(objects, 'W', BOARD / 2, 0, 0, BOARD, BOARD, BASE_HEIGHT)

mix_left = [['W', 'R'], ['R', 'W'], ['W', 'U'], ['U', 'W'], ['R', 'U', 'R'], ['U', 'R', 'U']]
mix_right = [['K', 'R'], ['R', 'K'], ['K', 'U'], ['U', 'K'], ['R', 'W', 'R'], ['U', 'W', 'U']]
cells = []
for side in range(2):
    base = 'K' if side == 0 else 'W'
    recipes = []
    for f in ['W', 'K', 'R', 'U']:
        for n in SINGLE_STEPS:
            recipes.append({'kind': 'single', 'filament': f, 'recipe': [f] * n, 'layers': n})
    for recipe in (mix_left if side == 0 else mix_right):
        recipes.append({'kind': 'mixed', 'recipe': recipe, 'layers': len(recipe)})
    for row in range(6):
        for col in range(3):
            recipe = recipes[row * 3 + col]
            x = 6.75 + (side * 3 + col) * 10.5
            y = 6.75 + row * 10.5
            cell = {
                'id': f'{"B" if side == 0 else "W"}-{row + 1}{col + 1}',
                'x': x, 'y': y, 'size': 9.0, 'cx': x + 4.5, 'cy': y + 4.5,
                'base': base, **recipe,
            }
            cells.append(cell)
            z = BASE_HEIGHT
            run_start = 0
            sequence = recipe['recipe']
            for i in range(1, len(sequence) + 1):
                if i == len(sequence) or sequence[i] != sequence[run_start]:
                    f = sequence[run_start]
                    next_z = z + (i - run_start) * LAYER
                    add_box(objects, f, x, y, z, x + 9, y + 9, next_z)
                    z = next_z
                    run_start = i

# High-contrast photographic corner markers, two 0.08 mm layers above the base.
markers = []
for x, y, f in [(1.5, 1.5, 'W'), (70.5, 1.5, 'K'), (70.5, 70.5, 'K'), (1.5, 70.5, 'W')]:
    add_box(objects, f, x, y, BASE_HEIGHT, x + 3, y + 3, BASE_HEIGHT + 2 * LAYER)
    markers.append({'x': x, 'y': y, 'cx': x + 1.5, 'cy': y + 1.5, 'size': 3, 'filament': f,
                    'z0': BASE_HEIGHT, 'z1': BASE_HEIGHT + 2 * LAYER})

# Compute the actual expected global material set at every Z layer.
layer_materials = []
for layer in range(TOTAL_LAYERS):
    active = set()
    if layer < BASE_LAYERS:
        active = {'K', 'W'}
    else:
        colour_layer = layer - BASE_LAYERS
        for cell in cells:
            if colour_layer < len(cell['recipe']):
                active.add(cell['recipe'][colour_layer])
        if colour_layer < 2:
            active.update(m['filament'] for m in markers)
    layer_materials.append([INDEX[f] for f in ['K', 'W', 'R', 'U'] if f in active])

metadata = {
    'app': 'ChromaStack TD Matrix',
    'version': 1,
    'boardMm': [BOARD, BOARD],
    'firstLayerHeight': FIRST_LAYER,
    'layerHeight': LAYER,
    'baseLayers': BASE_LAYERS,
    'baseHeight': BASE_HEIGHT,
    'totalLayers': TOTAL_LAYERS,
    'maxHeight': MAX_HEIGHT,
    'zEdges': Z_EDGES,
    'singleSteps': SINGLE_STEPS,
    'printMode': 'multi-filament-per-layer',
    'palette': PALETTE,
    'cells': cells,
    'markers': markers,
    'layerMaterials': layer_materials,
    'note': 'L1=0.24mm; L2-L12=0.08mm. Single-filament anchors contain 1/4/10 colour layers over black or white bases.',
}

parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">',
    ' <metadata name="Application">ChromaStack TD Matrix</metadata>',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <resources>',
    '  <basematerials id="1">',
]
for p in PALETTE:
    parts.append(f'   <base name="{p["name"]}" displaycolor="{p["hex"].upper()}FF" />')
parts.append('  </basematerials>')
for i, p in enumerate(PALETTE):
    object_id = i + 2
    data = objects[p['code']]
    parts.append(f'  <object id="{object_id}" type="model" pid="1" pindex="{i}" name="{p["name"]} · AMS {p["ams"]} · 基底与色格">')
    parts.append('   <mesh><vertices>')
    pos = data['pos']
    for j in range(0, len(pos), 3):
        parts.append(f'    <vertex x="{pos[j]:.4f}" y="{pos[j + 1]:.4f}" z="{pos[j + 2]:.4f}" />')
    parts.append('   </vertices><triangles>')
    idx = data['idx']
    for j in range(0, len(idx), 3):
        parts.append(f'    <triangle v1="{idx[j]}" v2="{idx[j + 1]}" v3="{idx[j + 2]}" />')
    parts.append('   </triangles></mesh>')
    parts.append('  </object>')
assembly_id = len(PALETTE) + 2
parts.append(f'  <object id="{assembly_id}" type="model" name="ChromaStack_TD_Matrix_75mm_L12"><components>')
for i in range(len(PALETTE)):
    parts.append(f'   <component objectid="{i + 2}" />')
parts.extend(['  </components></object>', ' </resources>', f' <build><item objectid="{assembly_id}" /></build></model>'])

model_settings = f'''<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="{assembly_id}">
  <metadata key="name" value="ChromaStack TD Matrix 75mm L12"/>
  <metadata key="extruder" value="1"/>
{chr(10).join(f'  <part id="{i + 2}" subtype="normal_part"><metadata key="name" value="{escape(p["name"])}"/><metadata key="extruder" value="{p["ams"]}"/></part>' for i, p in enumerate(PALETTE))}
 </object>
 <plate>
  <metadata key="plater_id" value="1"/><metadata key="plater_name" value="TD Matrix 75mm L12"/><metadata key="locked" value="false"/>
  <model_instance><metadata key="object_id" value="{assembly_id}"/><metadata key="instance_id" value="0"/></model_instance>
 </plate>
 <assemble><assemble_item object_id="{assembly_id}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 90 90 0" offset="0 0 0" /></assemble>
</config>'''
content_types = '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="text/xml"/>
 <Default Extension="json" ContentType="application/json"/>
 <Override PartName="/Metadata/model_settings.config" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Override PartName="/Metadata/chromastack-td-matrix.json" ContentType="application/json"/>
</Types>'''
rels = '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>'''

assert TOTAL_LAYERS == 12 and abs(MAX_HEIGHT - 1.12) < 1e-9
assert len(cells) == 36 and sum(c['kind'] == 'mixed' for c in cells) == 12
assert all(m == [0, 1] for m in layer_materials[:2])
assert all(m == [0, 1, 2, 3] for m in layer_materials[2:])
with zipfile.ZipFile(OUT, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.writestr('[Content_Types].xml', content_types)
    z.writestr('_rels/.rels', rels)
    z.writestr('3D/3dmodel.model', '\n'.join(parts))
    z.writestr('Metadata/model_settings.config', model_settings)
    z.writestr('Metadata/chromastack-td-matrix.json', json.dumps(metadata, ensure_ascii=False, indent=2))
print(OUT)
print(f'75 x 75 x {MAX_HEIGHT:.2f} mm; {TOTAL_LAYERS} layers; 36 cells; AMS Black/White/Red/Blue')
print('global material changes lower bound:', sum(len(m) for m in layer_materials) - 1)
