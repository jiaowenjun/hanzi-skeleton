"""Bitmap -> geometric skeleton graph: segmentation, thinning, pruning, analyze.

Python 3.12; uv sync (deps declared in pyproject.toml, locked in uv.lock)
Example: uv run hanzi-skeleton input.jpg --crop 12 12 732 732 --out result
Coordinates: crop-local pixels, x rightwards, y downwards. Edges are undirected.
"""
from __future__ import annotations

import networkx as nx
import numpy as np
from scipy import ndimage as ndi
from skimage.filters import gaussian, threshold_otsu
from skimage.measure import approximate_polygon
from skimage.morphology import closing, disk, skeletonize
import sknw


def remove_specks(mask, min_area):
    labels, n = ndi.label(mask, np.ones((3, 3)))
    sizes = np.bincount(labels.ravel(), minlength=n + 1)
    keep = sizes >= min_area
    keep[0] = False
    return keep[labels]


def fill_small_holes(mask, max_area):
    labels, n = ndi.label(~mask)  # 4-connected background / 8-connected foreground
    sizes = np.bincount(labels.ravel(), minlength=n + 1)
    fill = sizes <= max_area
    fill[0] = False
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    fill[border] = False
    return mask | fill[labels]


def build_graph(skeleton):
    return sknw.build_sknw(skeleton.astype(np.uint16), multi=True,
                          iso=True, ring=True, full=True)


def prune_short_leaves(skeleton, distance, max_length, iterations=2):
    """Conservative heuristic: only short endpoint-to-junction spurs.

    Isolated branches are not deleted here. No claim that remaining ends are
    pen starts/ends. Keep both absolute and local-radius tests to limit damage.
    """
    out = skeleton.copy()
    for _ in range(iterations):
        graph = build_graph(out)
        remove = np.zeros_like(out)
        for u, v, key, edge in graph.edges(keys=True, data=True):
            if u == v:
                continue
            du, dv = graph.degree(u), graph.degree(v)
            if not ((du == 1 and dv >= 3) or (dv == 1 and du >= 3)):
                continue
            junction = v if du == 1 else u
            r, c = np.rint(graph.nodes[junction]['o']).astype(int)
            if edge['weight'] >= min(max_length, 1.5 * distance[r, c]):
                continue
            pts = edge['pts'].astype(int)
            remove[pts[:, 0], pts[:, 1]] = True
        # Preserve the full junction clusters, not just their representative.
        for node, data in graph.nodes(data=True):
            if graph.degree(node) >= 3:
                pts = data['pts'].astype(int)
                remove[pts[:, 0], pts[:, 1]] = False
        if not remove.any():
            break
        out[remove] = False
    return out


def analyze(image, *, clean=True, min_area=80, prune_px=12, sigma=1.0):
    gray = np.asarray(image.convert('L'), dtype=float) / 255
    smooth = gaussian(gray, sigma=sigma, preserve_range=True)
    threshold = float(threshold_otsu(smooth))
    mask = smooth > threshold  # These rubbings have bright foreground.
    if clean:
        mask = remove_specks(mask, min_area)
        mask = closing(mask, footprint=disk(1), mode='ignore')
        mask = fill_small_holes(mask, 48)
    distance = ndi.distance_transform_edt(mask)
    skeleton = skeletonize(mask, method='zhang')
    if clean and prune_px > 0:
        skeleton = prune_short_leaves(skeleton, distance, prune_px)
    graph = build_graph(skeleton)
    nodes = []
    for node, attr in graph.nodes(data=True):
        y, x = attr['o']
        degree = graph.degree(node)
        kind = 'isolated' if degree == 0 else 'endpoint' if degree == 1 else 'junction' if degree >= 3 else 'cycle_anchor'
        nodes.append(dict(id=int(node), x=round(float(x), 2), y=round(float(y), 2),
                          degree=int(degree), type=kind))
    edges = []
    for eid, (u, v, key, attr) in enumerate(graph.edges(keys=True, data=True)):
        pts = np.asarray(attr['pts'], dtype=float)
        simple = approximate_polygon(pts, tolerance=0.65) if len(pts) > 2 else pts
        # Samples for presentation only, separate from graph vertices.
        lengths = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
        positions = np.arange(20., lengths[-1] - 8., 24.) if len(lengths) else []
        samples = [[round(float(np.interp(t, lengths, pts[:, 1])), 2),
                    round(float(np.interp(t, lengths, pts[:, 0])), 2)] for t in positions]
        ix = np.rint(pts).astype(int)
        widths = 2 * distance[ix[:, 0], ix[:, 1]]
        edges.append(dict(id=eid, source=int(u), target=int(v), key=int(key),
                          length_px=round(float(attr['weight']), 3),
                          mean_width_px=round(float(widths.mean()), 3),
                          points_xy=np.round(pts[:, ::-1], 2).tolist(),
                          display_points_xy=np.round(simple[:, ::-1], 2).tolist(),
                          sample_points_xy=samples,
                          width_samples_px=np.round(widths, 2).tolist()))
    ys, xs = np.where(mask)
    centroid = [round(float(xs.mean()), 2), round(float(ys.mean()), 2)] if len(xs) else None
    bbox_center = [float((xs.min()+xs.max())/2), float((ys.min()+ys.max())/2)] if len(xs) else None
    result = dict(schema_version=1, coordinate_system='crop-local px; x right, y down',
                  width=image.width, height=image.height, directed=False,
                  interpretation='Geometric skeleton only; no stroke segmentation or stroke order.',
                  parameters=dict(sigma=sigma, threshold_otsu=threshold, clean=clean,
                                  min_component_area=min_area if clean else 0,
                                  closing_radius=1 if clean else 0,
                                  max_hole_area=48 if clean else 0,
                                  max_prune_length=prune_px if clean else 0),
                  centroid_xy=centroid, bbox_center_xy=bbox_center,
                  centroid_scope='all retained foreground, including any residual damage',
                  nodes=nodes, edges=edges,
                  statistics=dict(nodes=len(nodes), edges=len(edges),
                                  components=nx.number_connected_components(graph),
                                  endpoints=sum(n['type']=='endpoint' for n in nodes),
                                  junctions=sum(n['type']=='junction' for n in nodes),
                                  cycle_rank=graph.number_of_edges()-graph.number_of_nodes()+nx.number_connected_components(graph)))
    return result, mask, skeleton
