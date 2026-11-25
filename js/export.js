// Compose the visible pane canvases into one image and trigger a PNG download.

(() => {
  'use strict';
  const DC = (window.DrawingCompare = window.DrawingCompare || {});

  /**
   * @param {{ layout: 'side'|'stacked'|'overlay', canvases: HTMLCanvasElement[], gap?: number, background?: string,
   *           overlays?: HTMLCanvasElement[], strip?: (width: number) => HTMLCanvasElement | null }} opts
   *   `gap` is in device pixels (the pane canvases are already DPR-scaled).
   *   `overlays` (Proportions marks) are drawn over the canvas at the same index, pixel for pixel (same size as the pane canvas).
   *   `strip(width)` returns a report strip that is added under the images, `gap` away from them and from the edges.
   */
  function composeExport({ layout, canvases, gap = 16, background = '#000', overlays = null, strip = null }) {
    const out = document.createElement('canvas');
    const vertical = layout === 'stacked';
    const widths = canvases.map((c) => c.width);
    const heights = canvases.map((c) => c.height);
    const spacing = gap * (canvases.length - 1);
    out.width = vertical ? Math.max(...widths) : widths.reduce((a, b) => a + b, 0) + spacing;
    const imagesH = vertical ? heights.reduce((a, b) => a + b, 0) + spacing : Math.max(...heights);
    const stripCanvas = typeof strip === 'function' ? strip(Math.max(1, out.width - 2 * gap)) : null;
    out.height = imagesH + (stripCanvas ? stripCanvas.height + 2 * gap : 0);

    const ctx = out.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    let offset = 0;
    canvases.forEach((c, i) => {
      const x = vertical ? 0 : offset, y = vertical ? offset : 0, ov = overlays && overlays[i];
      ctx.drawImage(c, x, y);
      if (ov && ov.width && ov.height) ctx.drawImage(ov, x, y, c.width, c.height);
      offset += (vertical ? c.height : c.width) + gap;
    });
    if (stripCanvas) ctx.drawImage(stripCanvas, gap, imagesH + gap);
    return out;
  }

  function downloadCanvas(canvas, filename) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Could not encode PNG'));
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        resolve();
      }, 'image/png');
    });
  }

  DC.composeExport = composeExport;
  DC.downloadCanvas = downloadCanvas;
})();
