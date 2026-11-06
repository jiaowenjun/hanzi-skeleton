import { useCallback, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { CropStage } from '@/components/CropStage';
import { DropZone } from '@/components/DropZone';
import { ResultView } from '@/components/ResultView';
import * as HanziSkeleton from '@/pipeline.js';
import {
  frame, guessInvert, rgbaToGray, MAX_SIDE,
  type Crop, type RunOutput,
} from '@/lib/app-utils';

export default function App() {
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop | null>(null);
  const [invertTouched, setInvertTouched] = useState(false);
  const [clean, setClean] = useState(true);
  const [minArea, setMinArea] = useState('80');
  const [prunePx, setPrunePx] = useState('12');
  const [invert, setInvert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [output, setOutput] = useState<RunOutput | null>(null);
  const busyRef = useRef(false);

  const sourceW = source?.naturalWidth ?? 0;
  const sourceH = source?.naturalHeight ?? 0;

  const acceptImage = useCallback((img: HTMLImageElement) => {
    setSource(img);
    setCrop(null);
    setInvertTouched(false);
    setInvert(guessInvert(img, {
      x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight,
    }));
    setOutput(null);
  }, []);

  // The crop region decides bright-on-dark vs the reverse; never override a manual choice.
  const onCropEnd = useCallback(() => {
    if (!source || invertTouched) return;
    const region = crop ?? { x: 0, y: 0, w: sourceW, h: sourceH };
    setInvert(guessInvert(source, region));
  }, [source, crop, invertTouched, sourceW, sourceH]);

  const region = crop ?? (source ? { x: 0, y: 0, w: sourceW, h: sourceH } : null);
  const scaleNote = region && Math.max(region.w, region.h) > MAX_SIDE;

  const run = useCallback(async () => {
    if (busyRef.current || !source || !region) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const scale = Math.min(1, MAX_SIDE / Math.max(region.w, region.h));
      const W = Math.max(8, Math.round(region.w * scale));
      const H = Math.max(8, Math.round(region.h * scale));

      setProgress('准备输入…');
      await frame();
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, W, H);
      const rgba = ctx.getImageData(0, 0, W, H).data;
      let gray = rgbaToGray(rgba, W, H);
      if (invert) {
        const g = new Uint8Array(gray.length);
        for (let i = 0; i < gray.length; i++) g[i] = 255 - gray[i];
        gray = g;
      }

      setProgress('高斯平滑与 Otsu 二值化…');
      await frame();
      const t0 = performance.now();
      const { result, mask, skeleton } = HanziSkeleton.analyze(gray, W, H, {
        clean, minArea: Math.max(0, parseInt(minArea, 10) || 0),
        prunePx: Math.max(0, parseFloat(prunePx) || 0), sigma: 1.0,
      });
      const ms = Math.round(performance.now() - t0);

      setOutput({
        result, mask, skeleton, width: W, height: H,
        imageDataUrl: c.toDataURL('image/jpeg', 0.88),
      });
      setProgress(`完成，用时 ${ms} ms（本页内计算，未上传）`);
    } catch (err) {
      console.error(err);
      setProgress('处理失败：' + (err as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [source, region, invert, clean, minArea, prunePx]);

  return (
    <main className={`mx-auto px-4 pb-12 pt-6 ${output ? 'max-w-[1160px]' : 'max-w-[900px]'}`}>
      <h1 className="mb-1 text-xl font-semibold">拓片字形骨架分析</h1>
      <p className="mb-4 text-[13px] text-muted-foreground">
        在浏览器本地把亮色字形提取为几何骨架图。图片不会上传；蓝线是几何中心线，不是历史笔顺，节点数也不是笔画数。
      </p>

      <DropZone onImage={acceptImage} />

      {source && (
        <div className={`mt-3.5 grid items-start gap-3.5 ${output ? 'lg:grid-cols-2' : ''}`}>
        <Card className="p-3.5">
          <h2 className="mb-2 text-[15px] font-semibold">
            裁切单字{' '}
            <span className="text-xs font-normal text-muted-foreground">（在图上拖一个框，留空则处理全图）</span>
          </h2>
          <CropStage
            source={source}
            sourceW={sourceW}
            sourceH={sourceH}
            crop={crop}
            onCropChange={setCrop}
            onCropEnd={onCropEnd}
          />
          <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
            <Button variant="outline" size="sm" onClick={() => { setCrop(null); onCropEnd(); }}>
              重置为全图
            </Button>
            <span className="ml-auto text-xs text-muted-foreground">
              处理区域 {Math.round(region?.w ?? 0)}×{Math.round(region?.h ?? 0)} px
              {scaleNote ? `（超过 ${MAX_SIDE}px，将等比缩放后处理）` : ''}
            </span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-end gap-2.5">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">处理方式</Label>
              <Select value={clean ? 'clean' : 'raw'} onValueChange={(v) => setClean(v === 'clean')}>
                <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="clean">轻度去噪与剪枝</SelectItem>
                  <SelectItem value="raw">基础提取</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="opt-min-area" className="text-xs text-muted-foreground">最小连通面积 px</Label>
              <Input
                id="opt-min-area" type="number" min={0} step={10} value={minArea}
                className="w-[140px]" onChange={(ev) => setMinArea(ev.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="opt-prune" className="text-xs text-muted-foreground">剪枝长度 px</Label>
              <Input
                id="opt-prune" type="number" min={0} step={1} value={prunePx}
                className="w-[130px]" onChange={(ev) => setPrunePx(ev.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-[13px]">
              <Checkbox
                id="opt-invert"
                checked={invert}
                onCheckedChange={(v) => { setInvert(v === true); setInvertTouched(true); }}
              />
              <Label htmlFor="opt-invert" className="font-normal">反相（黑字白底）</Label>
            </label>
            <Button id="run-btn" className="ml-auto" disabled={busy} onClick={run}>提取骨架</Button>
          </div>
          <p className="mt-1.5 min-h-5 text-[13px] text-primary" aria-live="polite">{progress}</p>
        </Card>
        {output && <ResultView output={output} />}
        </div>
      )}

      <footer className="mt-7 text-xs leading-relaxed text-muted-foreground">
        本页为纯前端实现：算法与命令行版（src/hanzi_skeleton）逐阶段对齐，可在仓库中用{' '}
        <code>uv run python scripts/compare_port.py &amp;&amp; node scripts/compare_port.mjs</code>{' '}
        复现两者在三张样本上的对比。
      </footer>
    </main>
  );
}
