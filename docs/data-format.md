# 图数据约定

每个结果目录包含一个 `graph.json`，当前 `schema_version` 为 1。

## 坐标与来源

- 坐标单位是裁切图像中的像素，左上角为原点，x 向右、y 向下。
- `width`、`height` 为裁切图像尺寸。
- `crop_box_in_source` 为原图裁切框 `[left, top, right, bottom]`，右、下边界不包含。
- 由批量脚本生成的图还包含 `source_attachment`，原始文件的相对路径和 SHA-256 则在 `data/samples.json`。
- `directed=false`：边的起终点编号仅描述存储方向，不表示落笔和收笔。

## 顶层字段

| 字段 | 含义 |
|---|---|
| `parameters` | 平滑、Otsu 阈值、清理与剪枝参数 |
| `centroid_xy` | 所有保留前景的面积质心；没有前景时为 null |
| `bbox_center_xy` | 所有保留前景的包围盒中心 |
| `centroid_scope` | 明确质心仍可能包含残留损伤 |
| `nodes` | 拓扑节点列表 |
| `edges` | 无向多重图的路径边列表 |
| `statistics` | 节点数、边数、连通分量、端点、分叉和环秩 |

## 节点

每个节点包含 `id`、`x`、`y`、`degree` 和 `type`：

- `isolated`：度数 0。
- `endpoint`：度数 1。
- `junction`：度数至少为 3。
- `cycle_anchor`：当前导出器对度数 2 节点的标签，通常用于无分叉环上的锚点；不是书法转折类型。

相邻分叉像素由 sknw 合并为节点区域，导出的坐标是其代表位置。节点 ID 仅在本次图内有效，改变阈值或预处理后不能把相同 ID 视作同一个语义位置。

## 边

| 字段 | 含义 |
|---|---|
| `id` | 本次导出的边编号 |
| `source`、`target` | 引用 `nodes.id` |
| `key` | 同一对节点之间多条边的区分编号 |
| `length_px` | sknw 路径的几何长度，单位像素 |
| `points_xy` | 完整路径点序列 |
| `display_points_xy` | 仅为绘制简化的路径点序列 |
| `sample_points_xy` | 橙色显示采样点；不加入拓扑节点集合 |
| `width_samples_px` | 与完整路径逐点对应的局部估计宽度 |
| `mean_width_px` | 这些宽度样本的平均值 |

宽度为前景距离变换的两倍，只是几何近似；不是毛笔压力。骨架细化的路径也不必等于严格欧氏中轴。

环可用自环表示；同一对节点之间允许多条不同路径。`cycle_rank = edges - nodes + components`。统计端点和分叉时按图度数计算，自环对度数贡献 2。

## 查看器数据

`results/visual-data.json` 只保留展示所需的图像、简化路径、采样点、节点、质心和统计值。`results/index.html` 内嵌这一数据并可独立打开。研究或继续计算时应使用各样本目录的完整 `graph.json`。
