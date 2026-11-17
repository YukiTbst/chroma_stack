# 来源、许可与数据说明

本项目 **叠彩 ChromaStack** 以 **GNU Affero General Public License v3.0 only（AGPL-3.0-only）** 发布。根目录 `LICENSE` 为 AGPL-3.0 全文。

## 为什么是 AGPL

本项目使用/参考了以下 AGPL-3.0 项目的成果：

- **Lumina Studio / Lumina-Layers**：拓竹 PLA Basic 的 CMYW / 8 色实测 LUT 数据（`app/js/data-lut.js` 由 `research/Lumina` 中的 JSON 生成），5 层叠色与 LUT 匹配思路。
- **Kromacut**：正面 Hiding Distance、Flat Paint 分区、按耗材拆 part 的 3MF 导出思路；研究目录中保留了其文档与关键源码摘录。

如果只是自己想闭源使用，请直接替换这两部分数据/实现，并重新评估许可；当前仓库保持 AGPL 以尊重上游。

## 第三方项目

| 项目 | 许可 | 本仓库中的使用 |
| --- | --- | --- |
| [Lumina-Layers](https://github.com/lumina-layer-studio/Lumina-Layers) / [Lumina Studio](https://www.luminastudio.com.cn/) | AGPL-3.0 | 拓竹 PLA Basic LUT 数据、5 层配方思路、标定/LUT 概念 |
| [Kromacut](https://github.com/vycdev/Kromacut) | AGPL-3.0 | 正面 HD、Flat Paint、3MF 多 part 导出思路 |
| [prusa-fdm-mixer](https://github.com/prusa3d/prusa-fdm-mixer) | MIT | HueForge 耗材库同步数据（625 条 TD）、色差/混色评估方法 |
| [hueforge-at-home](https://github.com/LucasKendi/hueforge-at-home) | 见仓库 | 逐层叠色预览思路 |
| [td-free](https://github.com/mawoka-myblock/td-free) | 见仓库 | TD 测量硬件/流程参考 |
| [earcut](https://github.com/mapbox/earcut) | ISC | `app/js/earcut.js` 多边形三角化 |
| [HueForge](https://shop.thehueforge.com/) | 商业闭源 | 仅作为品类参照与 TD 数据来源；无隶属关系 |

## TD 数据

- `data/filaments.json` / `app/js/data-filaments.js`：由 `prusa3d/prusa-fdm-mixer` 的 `data/filament-library-hueforge.json`（2026-11 同步）生成，共 625 条；TD 为 HueForge affiliate 耗材库的参考值。
- `data/bambu-pla-basic-td.csv`：从中筛出的 14 个 BambuLab Basic PLA 颜色。
- Lumina LUT 的校准条件：层高 0.08 mm、线宽 0.42 mm、白色基底、5 个颜色层。LUT 里的 Cyan/Magenta/Yellow 采用 CMYW 套装的色值/校准，不与 HueForge 库里的其他 Yellow 混用。

**TD/HD 不是材料常数。** 批次、颜料、温度、层高、线宽、喷嘴、观察光都会影响；数据只作为起点。应用内的标定器是标量近似（三通道共用一个 HD），不能替代逐通道/矩阵校准。

## 示例图

`app/samples/landscape.jpg` 是为本项目演示生成的图像，不含第三方作品版权。用户导入图片的版权归用户/原作者所有；软件只在本地浏览器内处理，不上传。

## 商标

HueForge、Bambu Lab、拓竹、Lumina Studio、Kromacut、Prusa 等名称归各自权利人所有。本项目与它们没有官方隶属或背书关系。
