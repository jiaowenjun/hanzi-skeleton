import { useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Download } from 'lucide-react';
import {
  binaryDataUrl, overlaySvgText, download, MARKER_COLORS,
  type RunOutput,
} from '@/lib/app-utils';

type ViewMode = 'overlay' | 'image' | 'mask' | 'skeleton';

const VIEWS: { value: ViewMode; label: string }[] = [
  { value: 'overlay', label: '叠加骨架' },
  { value: 'image', label: '原图' },
  { value: 'mask', label: '二值图' },
  { value: 'skeleton', label: '骨架图' },
];

function Marker(props: { name: string; label: string; kind?: 'dot' | 'line' | 'square' }) {
  const { name, label, kind = 'dot' } = props;
  const style = {
    background: `var(--marker-${name}, ${MARKER_COLORS[name].light})`,
  } as React.CSSProperties;
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        aria-hidden
        style={style}
        className={`inline-block size-2.5 rounded-full ${kind === 'line' ? '!h-0.5 !w-4 rounded-none' : ''} ${kind === 'square' ? 'rounded-[2px]' : ''}`}
      />
      {label}
    </span>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <Marker name="edge" label="骨架路径" kind="line" />
      <Marker name="endpoint" label="几何端点" />
      <Marker name="junction" label="分叉节点" kind="square" />
      <Marker name="sample" label="路径采样点" />
      <Marker name="center" label="前景质心" />
    </div>
  );
}

interface ResultViewProps {
  output: RunOutput;
}

export function ResultView({ output }: ResultViewProps) {
  const [view, setView] = useState<ViewMode>('overlay');
  const cacheRef = useRef<Record<string, string>>({});
  const { result, width, height, imageDataUrl, mask, skeleton } = output;

  const layerUrl = useMemo(() => {
    if (view === 'image') return imageDataUrl;
    if (view === 'mask') {
      cacheRef.current.mask ??= binaryDataUrl(mask, width, height);
      return cacheRef.current.mask;
    }
    if (view === 'skeleton') {
      cacheRef.current.skeleton ??= binaryDataUrl(skeleton, width, height);
      return cacheRef.current.skeleton;
    }
    return null;
  }, [view, imageDataUrl, mask, skeleton, width, height]);

  const mark = (name: string) => `var(--marker-${name}, ${MARKER_COLORS[name].light})`;
  const s = result.statistics;

  return (
    <Card className="p-3.5">
      <div className="flex justify-center">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="骨架叠加结果"
          className="h-auto max-w-full rounded-md border bg-background"
        >
          <title>几何骨架，不代表真实笔顺</title>
          <rect width="100%" height="100%" fill="var(--background, transparent)" />
          <image
            href={layerUrl ?? imageDataUrl}
            width={width}
            height={height}
            opacity={view === 'overlay' ? 0.42 : 1}
          />
          {view === 'overlay' && (
            <>
              {result.edges.map((e: any) => (
                <g key={e.id}>
                  <polyline
                    points={e.display_points_xy.map((p: number[]) => p.join(',')).join(' ')}
                    fill="none"
                    stroke={mark('edge')}
                    strokeWidth={1.7}
                    strokeLinejoin="round"
                  />
                  {e.sample_points_xy.map(([x, y]: number[], i: number) => (
                    <circle key={i} cx={x} cy={y} r={2.9} fill={mark('sample')} stroke="var(--marker-bg, var(--background))" strokeWidth={1} />
                  ))}
                </g>
              ))}
              {result.nodes.map((n: any) => n.type === 'junction' ? (
                <rect
                  key={n.id}
                  x={n.x - 3.4} y={n.y - 3.4} width={6.8} height={6.8} rx={1}
                  fill={mark('junction')} stroke="var(--marker-bg, var(--background))" strokeWidth={1}
                />
              ) : (
                <circle
                  key={n.id}
                  cx={n.x} cy={n.y} r={n.type === 'isolated' ? 2.3 : 3.5}
                  fill={mark(n.type === 'endpoint' ? 'endpoint' : n.type === 'isolated' ? 'isolated' : 'sample')}
                  stroke="var(--marker-bg, var(--background))" strokeWidth={1}
                />
              ))}
              {result.centroid_xy && (
                <g>
                  <path
                    d={`M0 ${result.centroid_xy[1]}H${width} M${result.centroid_xy[0]} 0V${height}`}
                    fill="none" stroke={mark('center')} strokeWidth={1.2} strokeDasharray="8 6"
                  />
                  <circle
                    cx={result.centroid_xy[0]} cy={result.centroid_xy[1]} r={6.5}
                    fill="none" stroke={mark('center')} strokeWidth={1.7}
                  />
                </g>
              )}
            </>
          )}
        </svg>
      </div>

      <div className="mt-2.5 flex flex-wrap items-end gap-2.5">
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">显示</span>
          <Select value={view} onValueChange={(v) => setView(v as ViewMode)}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {VIEWS.map((v) => (
                <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {view === 'overlay' && <div className="ml-auto"><Legend /></div>}
      </div>

      <p className="mt-2 min-h-5 text-xs text-muted-foreground" aria-live="polite">
        {s.nodes} 个几何节点 · {s.edges} 条骨架边 · {s.components} 个连通分量 ·
        Otsu 阈值 {result.parameters.threshold_otsu.toFixed(3)}（均非笔画数量）
      </p>

      <div className="mt-2.5 flex flex-wrap gap-2">
        {[
          { name: 'graph.json', mime: 'application/json', data: () => JSON.stringify(result, null, 2) },
          { name: 'overlay.svg', mime: 'image/svg+xml', data: () => overlaySvgText(output) },
          { name: 'mask.png', mime: 'image/png', data: () => layerOf(cacheRef.current, 'mask', () => binaryDataUrl(mask, width, height)) },
          { name: 'skeleton.png', mime: 'image/png', data: () => layerOf(cacheRef.current, 'skeleton', () => binaryDataUrl(skeleton, width, height)) },
        ].map((item) => (
          <Button key={item.name} variant="outline" size="sm" onClick={() => download(item.name, item.mime, item.data())}>
            <Download aria-hidden /> {item.name}
          </Button>
        ))}
      </div>
    </Card>
  );
}

function layerOf(cache: Record<string, string>, key: string, make: () => string): string {
  cache[key] ??= make();
  return cache[key];
}
