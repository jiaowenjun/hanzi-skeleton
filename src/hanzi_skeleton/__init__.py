"""Geometric skeleton extraction and graph analysis for Chinese inscription rubbings.

Public API mirrors the original single-module ``rubbing_graph.py``:
``analyze``, ``build_graph``, ``prune_short_leaves``, ``remove_specks``,
``fill_small_holes``, ``COLORS``, ``render_overlay``, ``render_svg`` and
``save_results``. The command line entry point lives in ``hanzi_skeleton.cli``.
"""
from hanzi_skeleton.pipeline import (
    analyze,
    build_graph,
    fill_small_holes,
    prune_short_leaves,
    remove_specks,
)
from hanzi_skeleton.render import COLORS, render_overlay, render_svg, save_results

__version__ = '0.1.0'

__all__ = [
    'analyze', 'build_graph', 'prune_short_leaves', 'remove_specks',
    'fill_small_holes', 'COLORS', 'render_overlay', 'render_svg', 'save_results',
]
