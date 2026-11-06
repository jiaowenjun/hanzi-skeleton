import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Upload } from 'lucide-react';
import { makeDemoDataURL } from '@/lib/app-utils';

interface DropZoneProps {
  onImage: (img: HTMLImageElement) => void;
}

/** Picture intake: click-to-pick, drag & drop, clipboard paste, or the built-in demo glyph. */
export function DropZone({ onImage }: DropZoneProps) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadFile = useCallback((file: File | undefined | null) => {
    if (!file || !/^image\//.test(file.type)) {
      if (file) alert('请选择图片文件');
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); onImage(img); };
    img.onerror = () => { URL.revokeObjectURL(url); alert('图片解码失败'); };
    img.src = url;
  }, [onImage]);

  const loadDemo = useCallback(() => {
    const img = new Image();
    img.onload = () => onImage(img);
    img.src = makeDemoDataURL();
  }, [onImage]);

  // Clipboard paste anywhere on the page.
  useEffect(() => {
    const onPaste = (ev: ClipboardEvent) => {
      const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (item) loadFile(item.getAsFile());
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadFile]);

  return (
    <Card className="p-3.5">
      <div
        role="button"
        tabIndex={0}
        aria-label="选择或拖入图片"
        className={`flex flex-col items-center gap-2 rounded-lg border-1.5 border-dashed p-5 text-center text-muted-foreground transition-colors ${
          over ? 'border-primary text-primary' : 'border-border cursor-pointer hover:text-foreground'
        }`}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') inputRef.current?.click(); }}
        onDragEnter={(ev) => { ev.preventDefault(); setOver(true); }}
        onDragOver={(ev) => { ev.preventDefault(); setOver(true); }}
        onDragLeave={(ev) => { ev.preventDefault(); setOver(false); }}
        onDrop={(ev) => { ev.preventDefault(); setOver(false); loadFile(ev.dataTransfer.files[0]); }}
      >
        <Upload className="size-5 opacity-70" aria-hidden />
        <p className="text-sm">
          点击选择图片、拖入或粘贴（Ctrl/⌘+V）拓片照片；也可以先
          <Button
            id="demo-btn"
            variant="ghost"
            size="sm"
            className="h-auto px-1.5 py-0.5 text-sm"
            onClick={(ev) => { ev.stopPropagation(); loadDemo(); }}
          >
            载入合成示例
          </Button>
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(ev) => { loadFile(ev.target.files?.[0]); ev.target.value = ''; }}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        要求亮字暗底；黑字白底请勾选「反相」。面积、长度参数以约 700 像素宽的图片为基准。
      </p>
    </Card>
  );
}
