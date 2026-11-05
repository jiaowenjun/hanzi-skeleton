# Hanzi Skeleton

将碑刻拓片的亮色字形提取为几何骨架，并导出节点、路径、长度及估计宽度。提供命令行工具、三张真实拓片的复现实验和独立交互查看器。

本项目实现的是几何分析，不包含汉字识别、真实笔画分离、起收笔判断或笔顺恢复。蓝线不等于历史运笔轨迹，残留的裂纹和石花也可能进入图结构。

![三张原拓片及计算结果](results/comparison.png)

## 快速开始

使用 [uv](https://docs.astral.sh/uv/) 管理依赖，要求 Python 3.12 或更高版本（uv 会按 `.python-version` 自动获取解释器）。在项目目录安装：

```bash
uv sync
```

依赖由 `pyproject.toml` 声明、`uv.lock` 锁定；直接依赖与传递依赖的版本均与本次复现环境一致。

处理已有样本：

```bash
uv run hanzi-skeleton data/original/sample2.jpg \
  --crop 12 12 732 701 --out work/sample2
```

也可以直接运行脚本：

```bash
uv run python rubbing_graph.py data/original/sample2.jpg \
  --crop 12 12 732 701 --out work/sample2
```

输出 `input.png`、`mask.png`、`skeleton.png`、`overlay.png`、`overlay.svg` 和 `graph.json`。可用 `--raw` 跳过去噪与剪枝，或用 `--min-area 80 --prune-px 12` 调整参数。

`--crop` 顺序为左、上、右、下，右、下不包含；已裁好的单字图片可省略。当前处理方向为亮字暗底，黑字白底需先反相。面积和长度参数以约 700 像素宽图片为基准。

## 重建全部结果

```bash
uv run python scripts/build_demo.py
```

脚本从项目内的原始图片和裁切记录生成三组 `raw`/`clean` 结果、对比图、统计摘要与交互页面。可从任意工作目录调用，默认输出总是项目内的 `results/`；用 `--out work/reproduced` 可以输出到其他目录。

直接在浏览器打开 [results/index.html](results/index.html)，切换样本、处理方式和原图／二值图／骨架图。页面包含全部数据，可离线打开，不要求运行 Python 服务或安装 Codex。macOS 可执行：

```bash
open results/index.html
```

## 项目结构

```text
hanzi-skeleton/
├── rubbing_graph.py          # 分割、骨架、图构建、导出与 CLI
├── pyproject.toml            # 包信息、依赖声明和 hanzi-skeleton 命令入口
├── uv.lock                   # 锁定的依赖版本（含传递依赖）
├── scripts/build_demo.py     # 批量复现、数据校验和页面构建
├── data/
│   ├── original/             # 用户提供的三张完整参考图片
│   └── samples.json          # 文件来源、SHA-256 和人工裁切框
├── web/
│   ├── graph.fragment.html   # 查看器内容与交互代码
│   └── viewer-shell.html     # 独立页面外壳及样式
├── results/
│   ├── index.html            # 可独立打开的交互结果
│   ├── comparison.png        # 三张图的静态对比
│   ├── summary.json          # 结果统计及运行依赖版本
│   ├── visual-data.json      # 查看器使用的精简数据
│   └── samples/              # 每张图的 raw/clean 结果
└── docs/
    ├── implementation.md     # 算法、参数、图例、研究资料和局限
    ├── development-log.md    # 实现过程、修正记录及项目整理
    └── data-format.md        # 图数据结构与坐标约定
```

## 已完成的结果

| 样本 | 基础提取：节点／边／连通分量 | 轻度去噪：节点／边／连通分量 |
|---|---:|---:|
| 图一 | 304 / 190 / 124 | 100 / 96 / 11 |
| 图二 | 228 / 149 / 85 | 88 / 83 / 7 |
| 图三 | 509 / 305 / 219 | 147 / 141 / 20 |

这些数值不是笔画数量或识别准确率。第三张右侧的长裂纹清理后仍然存在。前景质心也会受到残留损伤与邻字碎片的影响。

复现脚本检查输入文件摘要、图边引用、路径坐标范围、宽度数组长度和图度数一致性。已有结果经过叠加图目视检查，但没有真实笔画标注可供计算识别准确率。

## 后续方向

先增加单字裁切、裂纹遮罩和人工图编辑，再考虑笔画实例分割、字形模板配准及笔顺先验。字体矢量化还需要保留外轮廓和内部留白，不能只依赖中心线。

研究依据、开源项目和数据许可差异见 [实现说明](docs/implementation.md)。原始参考图片含原作者的标记；将其保存在本地项目不表示获得了公开再发布的授权。

