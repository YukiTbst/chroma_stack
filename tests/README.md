# 快速验证

这些脚本用于开发回归，不是应用运行所需。

## 核心

```bash
cd ..
node tests/test-engine.mjs      # 合成图：LUT 8 / LUT 4 / TD 变高
node tests/test-3mf.mjs         # 小图 3MF，写出 tests/sample.3mf
node tests/test-large-3mf.mjs   # 240px 合成图 3MF
node tests/test-line-protect.mjs # 细线检测/自动保护/强直印；照片不误触发
node tests/test-height-merge.mjs # 同色高矮配方合并/面积保护/色差门槛
node tests/test-edge-clean.mjs   # 抗锯齿边缘检测/颜色族不增加/色差可控
node tests/test-physical-smooth.mjs # 平滑尺寸(mm)→像素半径随成品宽度变化，3mm 不再被 8px 截断
node tests/test-structural-cleanup.mjs # 三项清理、全纯色掩膜、线稿连续性及 3MF 降采样不重建单像素
node tests/test-3mf-deflate.mjs  # 同步 store 与异步 DEFLATE 3MF；trimesh 均可读
node tests/test-layer-consistency.mjs # 原生逐层一致：黑色短配方结束后上方不得出现白色实体
node tests/test-view3d.mjs      # 3D 正反方向、真实材料侧壁和 X 剖面缓冲
node tests/test-manual-calc.mjs  # 参数/耗材统一手动计算、连续加料不逐次分析、平滑数字输入
node tests/test-background.mjs  # 边界背景、气泡距离场、四连通、内部空腔切换、低层支撑、异形3D/3MF
node tests/test-settings.mjs   # 仅耗材标定持久化、LUT分区、异常存储、工程参数不落地
node tests/test-batch-calibration.mjs # 单色/Z金字塔、四点透视、非不透明参考下的白平衡与实色/HD/TD联合拟合
```

3MF 用 trimesh 验证：

```bash
python -c "import trimesh; m=trimesh.load('tests/sample.3mf'); print(len(m.geometry), all(g.is_watertight for g in m.geometry.values()), m.bounds.tolist())"
```

## 网页

```bash
cd app
python -m http.server 8123
```

打开 `http://127.0.0.1:8123/`。手工检查：

1. 默认是 **TD 浮雕**，5 色；纯色区直接铺色，渐变区变高。
2. 在「色域」视图看红色/橙色缺口；点「加入建议耗材」应重算并降低色域外比例。
3. 在「分层」视图，浅色棋盘格应表示该层无材料；黑色耗材应是实心黑色。
4. 画布上方工具条的“平滑”0→4：层内细碎色点应减少，色差会上升；0 时应最锐利。
5. TD 配方应是连续色段（如黑×3→红×3→白×1），不能出现红-蓝-红-蓝这种重复跨段。
6. 关掉“渐变随配方变高”，所有渐变 recipe 应变为最大层数，3MF 顶面等高。
7. 切换物理 LUT，指标应变为 8 色 LUT 的结果；再切回 TD。
8. 画笔涂一块纯色 → 重算；撤销 / 清除手绘。
9. 导出 3MF；用 trimesh 验证每个 part watertight，Z 高度应为 `层号 × 0.08` 毫米（示例约 1.76 mm，不是 22 mm）。
10. 标定 → 下载楔形 3MF；输入片号 → 计算 HD/TD。
11. 「区域策略」层序合并 0→6：共享底层比例应上升，色差会上升；0 时 sharedBasePercent=0。
12. 打开「3D」标签：应能拖动旋转、滚轮缩放、调高度夸张/重置视角；切回 2D 不应报错。
13. 打印计划包：preview.png、region_map.png、print_plan.json/md、layer_maps/、README.txt。
14. 导入白底贴纸线稿：线稿保护应为“已保护 x% 细线”；切“关闭”时细线可能变碎，切“强”时深色描边变为连续纯色。照片/油画应显示“未检测到线稿”。
