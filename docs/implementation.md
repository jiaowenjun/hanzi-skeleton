# 算法实现、实验结果与研究资料

本项目从三张参考图片的上半幅原拓片独立计算骨架。裁切框为人工指定；没有使用下半幅标注图作训练，也没有手工描画蓝线。

安装和运行方式见 [项目 README](../README.md)，实现记录见 [开发日志](development-log.md)，数据字段见 [数据格式](data-format.md)。

## 实际算法

1. 灰度化；Gaussian sigma=1 像素平滑。
2. Otsu 阈值分割，亮色作为前景。
3. `raw` 到此结束预处理；`clean` 额外删除面积小于 80 像素的连通区域、以半径 1 像素闭运算处理微小缺口，并填补不接触边界、面积不超过 48 像素的小孔。
4. `skimage.morphology.skeletonize(method='zhang')` 生成单像素骨架。用距离变换保存局部半径。
5. `clean` 最多做两轮短末梢修剪：只考虑端点—分叉边，长度同时小于 12 像素和分叉处局部半径的 1.5 倍。该启发式仍可能损伤真实短笔锋。
6. `sknw.build_sknw(multi=True, iso=True, ring=True, full=True)` 生成无向多重图，保留孤立节点、环以及平行路径。
7. 绘图时对路径作 0.65 像素容差的折线简化；原始路径仍保存在 JSON。橙色采样点每隔约 24 像素设置，是显示标记，不是角点检测结果，也不加入拓扑节点集合。

## 图例与字段

本实验自行定义颜色，不能用于证明用户示例中颜色的原始含义：

- 蓝线：几何骨架路径。
- 绿点：图度数为 1 的几何端点，可能是真实笔锋，也可能是噪声末梢。
- 红点（交互对比中用红方块）：图度数至少为 3 的分叉节点。
- 橙点：路径采样点；少量度数为 2 的环锚点也采用橙色。
- 灰点：孤立节点。
- 紫色十字：所有保留前景像素的面积质心，包括残留的石花、邻字碎片和裂纹；不等于经过识别后的单字重心，也不等于书法审美重心。

`graph.json` 坐标是裁切后的像素坐标，x 向右，y 向下。`crop_box_in_source` 保留原图裁切框。`nodes` 保存节点坐标、度数和类型；`edges` 保存起终节点、完整路径、显示用简化路径、长度和沿路径的估计宽度。`width_samples_px` 是距离变换的两倍，代表几何宽度近似，不是毛笔压力。图无方向、无笔顺，节点和边的数量均不是书法笔画数。

## 本次结果

| 样本 | 基础提取：节点/边/分量 | 轻度去噪：节点/边/分量 |
|---|---:|---:|
| 图一 | 304 / 190 / 124 | 100 / 96 / 11 |
| 图二 | 228 / 149 / 85 | 88 / 83 / 7 |
| 图三 | 509 / 305 / 219 | 147 / 141 / 20 |

这些是几何图的统计结果，不是识别准确率。对三张图检查了导出边引用、路径坐标范围、有限数值和图度数一致性，并目视检查叠加效果；没有人工标注的真实笔画图可供计算准确率。

第三张右侧的长裂纹在清理后依然存在，因为它不是小连通区域。第一张的邻字碎片也可能保留。不能用“只取最大连通域”修复所有问题：一个正确汉字本来就可能包含多个互不连接的笔画。闭运算、填孔及剪枝也会改变几何结构，参数选择需要原图对照。

## 若要进一步做成产品

先做可校正的几何分析工具：裁切单字、背景/裂纹遮罩、去噪参数、骨架对照、删除伪分支、手工连接断裂处、JSON/SVG 导出。保留原始层和修正层，避免把修补结果误作原碑证据。

如需真正的笔画分离，可参考 CCSE 的实例分割路线，结合交叉点附近的方向、宽度连续性和字形先验；需要碑帖领域标注来验证和适配。二值分割网络只能区分字与背景，不能自动解决相互搭接的笔画归属。

如需笔顺演示，可在识别字形后引入 Make Me a Hanzi 的标准笔画数据，再做配准与人工校正。但标准楷体笔顺是先验，不是从此碑刻恢复的历史书写事实。相交笔画在二维图上已合并，几何骨架本身没有时间信息。

如需保真矢量字体，还要保留字的轮廓与内部留白。中心线配合半径只能近似重建形状；可以另外用 Potrace 输出封闭轮廓，两种表示用途不同。

## 已查阅的一手资料

- [scikit-image Skeletonize](https://scikit-image.org/docs/stable/auto_examples/edges/plot_skeleton.html)：Zhang/Lee 细化、中轴及距离变换示例。
- [LingDong-/skeleton-tracing](https://github.com/LingDong-/skeleton-tracing)：二值骨架转折线，含 JS、WASM、Python 等实现；MIT。
- [Image-Py/sknw](https://github.com/Image-Py/sknw)：骨架转 NetworkX 图；BSD-3-Clause。
- [Skan](https://github.com/jni/skan) 与 [入门文档](https://skeleton-analysis.org/stable/getting_started/getting_started.html)：骨架分支追踪、长度和连接分析；BSD-3-Clause。
- [CCSE](https://github.com/lizhaoliu-Lec/CCSE)：论文《Instance Segmentation for Chinese Character Stroke Extraction, Datasets and Benchmarks》的公开研究实现，提供手写及楷体数据集。README 使用旧版 PyTorch/Detectron2 环境；不是现成的碑拓专用工具。此次未确认其明确的代码/数据授权条款。
- [Make Me a Hanzi](https://github.com/skishore/makemeahanzi)：已有汉字的逐笔 SVG、medians 和笔顺数据，不负责从任意拓片中提取笔画。
- [Hanzi Writer](https://github.com/chanind/hanzi-writer)：标准汉字笔顺动画和练习；代码 MIT，字形数据使用单独的 Arphic Public License。
- [Potrace](https://potrace.sourceforge.net/)：位图轮廓矢量化，不能直接替代骨架图提取。

资料查阅日期：2026-11-05。以上技术可以解释相似的结果，但不能据此认定原图作者使用了某个具体算法、开源库或 AI 模型。
