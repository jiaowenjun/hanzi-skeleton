import { useEffect, useRef } from 'react';
import type { Crop } from '@/lib/app-utils';

interface CropStageProps {
  source: HTMLImageElement;
  sourceW: number;
  sourceH: number;
  crop: Crop | null;
  onCropChange: (crop: Crop | null) => void;
  onCropEnd: () => void;
}

/** Canvas with a drag-to-select crop rectangle (mouse and touch). */
export function CropStage({ source, sourceW, sourceH, crop, onCropChange, onCropEnd }: CropStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ a: { x: number; y: number } } | null>(null);

  // Redraw the image plus the current crop highlight whenever anything changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const maxW = Math.min(660, (canvas.parentElement?.clientWidth ?? 660));
    const scale = Math.min(1, maxW / sourceW, 520 / sourceH);
    canvas.width = Math.round(sourceW * scale);
    canvas.height = Math.round(sourceH * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    if (crop) {
      const s = canvas.width / sourceW;
      const cx = crop.x * s, cy = crop.y * s, cw = crop.w * s, ch = crop.h * s;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, cx, cy, cw, ch);
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary') || '#2474b8';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx, cy, cw, ch);
      ctx.restore();
    }
  }, [source, sourceW, sourceH, crop]);

  function canvasPoint(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.min(sourceW - 1, Math.max(0, (clientX - r.left) * sourceW / r.width)),
      y: Math.min(sourceH - 1, Math.max(0, (clientY - r.top) * sourceH / r.height)),
    };
  }

  function pointOf(ev: React.MouseEvent | React.TouchEvent): { clientX: number; clientY: number } {
    if ('touches' in ev && ev.touches.length) return ev.touches[0];
    return ev as React.MouseEvent;
  }

  const start = (ev: React.MouseEvent | React.TouchEvent) => {
    const p = pointOf(ev);
    dragRef.current = { a: canvasPoint(p.clientX, p.clientY) };
    ev.preventDefault();
  };

  const move = (ev: React.MouseEvent | React.TouchEvent) => {
    if (!dragRef.current) return;
    const p = pointOf(ev);
    const a = dragRef.current.a;
    const b = canvasPoint(p.clientX, p.clientY);
    onCropChange({
      x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
    });
    ev.preventDefault();
  };

  const end = () => {
    if (dragRef.current && crop && (crop.w < 8 || crop.h < 8)) onCropChange(null);
    dragRef.current = null;
    onCropEnd();
  };

  return (
    <div className="flex justify-center">
      <canvas
        ref={canvasRef}
        // Fills the card width so it lines up with the result SVG beside it;
        // the 660px cap only applies in single-column mode.
        className="mx-auto h-auto w-full max-w-[660px] touch-none rounded-md border bg-[repeating-conic-gradient(var(--muted)_0%_25%,var(--background)_0%_50%)] bg-[length:20px_20px]"
        onMouseDown={start}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={() => { if (dragRef.current) end(); }}
        onTouchStart={start}
        onTouchMove={move}
        onTouchEnd={end}
      />
    </div>
  );
}
