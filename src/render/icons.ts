// Unit-type icons drawn on a 2D canvas. Shared by the 3D top-face icons, the zoomed-out NATO
// markers and the DOM unit cards, so every view uses the same symbol.

/** Draw `icon` in white-ish strokes inside the box (x, y, w, h). */
export function drawSymbol(ctx: CanvasRenderingContext2D, icon: string, x: number, y: number, w: number, h: number, color = '#f6efdc', weight = 1) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.2, w * 0.04 * weight);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const cx = x + w / 2, cy = y + h / 2;
  const cross = () => {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y);
    ctx.lineTo(x, y + h);
    ctx.stroke();
  };
  const diag = () => {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w, y);
    ctx.stroke();
  };
  const bow = (bx: number, by: number, s: number) => {
    ctx.beginPath();
    ctx.arc(bx - s * 0.35, by, s * 0.6, -1.0, 1.0);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(bx - s * 0.35 + Math.cos(-1) * s * 0.6, by + Math.sin(-1) * s * 0.6);
    ctx.lineTo(bx - s * 0.35 + Math.cos(1) * s * 0.6, by + Math.sin(1) * s * 0.6);
    ctx.stroke();
  };
  switch (icon) {
    case 'spear':
      cross();
      ctx.beginPath();
      ctx.moveTo(cx, y + h * 0.05);
      ctx.lineTo(cx, y - h * 0.18);
      ctx.stroke();
      break;
    case 'sword':
      cross();
      ctx.beginPath();
      ctx.moveTo(x + w * 0.2, cy);
      ctx.lineTo(x + w * 0.8, cy);
      ctx.stroke();
      break;
    case 'bow':
      bow(cx + w * 0.12, cy, h * 0.8);
      break;
    case 'javelin':
      for (const dx of [-0.25, 0, 0.25]) {
        ctx.beginPath();
        ctx.moveTo(cx + w * dx - w * 0.08, y + h * 0.8);
        ctx.lineTo(cx + w * dx + w * 0.08, y + h * 0.2);
        ctx.stroke();
      }
      break;
    case 'elephant': {
      // Body, head and a curling trunk.
      ctx.beginPath();
      ctx.ellipse(cx - w * 0.06, cy - h * 0.02, w * 0.26, h * 0.26, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + w * 0.2, cy - h * 0.12);
      ctx.quadraticCurveTo(cx + w * 0.36, cy + h * 0.1, cx + w * 0.3, cy + h * 0.32);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.18, cy + h * 0.2);
      ctx.lineTo(cx - w * 0.18, cy + h * 0.38);
      ctx.moveTo(cx + w * 0.06, cy + h * 0.2);
      ctx.lineTo(cx + w * 0.06, cy + h * 0.38);
      ctx.stroke();
      break;
    }
    case 'cav-heavy':
      diag();
      ctx.beginPath();
      ctx.ellipse(cx, cy, w * 0.22, h * 0.2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'cav-archer':
      diag();
      bow(cx + w * 0.18, cy, h * 0.6);
      break;
    case 'unknown':
      ctx.font = `bold ${Math.round(h * 0.9)}px Georgia, serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', cx, cy + h * 0.04);
      break;
    default:
      cross();
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A slim NATO-style unit tag: rounded, translucent faction fill, hairline light border, thin
 * symbol, and a small chevron at the top marking the unit's front.
 */
export function markerCanvas(icon: string, fill: string, size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const w = size * 0.74, h = size * 0.46;
  const x = (size - w) / 2, y = (size - h) / 2 + size * 0.05;
  // Facing chevron.
  ctx.strokeStyle = 'rgba(246, 239, 220, 0.95)';
  ctx.lineWidth = size * 0.028;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(size / 2 - size * 0.07, y - size * 0.05);
  ctx.lineTo(size / 2, y - size * 0.12);
  ctx.lineTo(size / 2 + size * 0.07, y - size * 0.05);
  ctx.stroke();
  // Body.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = size * 0.05;
  roundRect(ctx, x, y, w, h, size * 0.06);
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
  const grad = ctx.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.12)');
  roundRect(ctx, x, y, w, h, size * 0.06);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineWidth = size * 0.018;
  ctx.strokeStyle = 'rgba(246, 239, 220, 0.9)';
  ctx.stroke();
  drawSymbol(ctx, icon, x + w * 0.2, y + h * 0.2, w * 0.6, h * 0.6);
  return c;
}

/** Just the thin symbol with a soft shadow, for the top face of a block. */
export function topIconCanvas(icon: string, size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = size * 0.06;
  drawSymbol(ctx, icon, size * 0.22, size * 0.3, size * 0.56, size * 0.4, 'rgba(250, 245, 232, 0.92)');
  return c;
}

/** A crisp, bolder symbol on a 2:1 transparent canvas, sized to fill a zoomed-out marker bar. */
export function barSymbolCanvas(icon: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 4;
  // Thicker strokes than the 3D top icon so it survives being drawn small.
  drawSymbol(ctx, icon, 64, 22, 128, 84, 'rgba(252, 248, 236, 0.98)', 1.9);
  return c;
}
