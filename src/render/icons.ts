// Unit-type icons drawn on a 2D canvas. Shared by the 3D top-face icons, the zoomed-out NATO
// markers and the DOM unit cards, so every view uses the same symbol.

/** Draw `icon` in white-ish strokes inside the box (x, y, w, h). */
export function drawSymbol(ctx: CanvasRenderingContext2D, icon: string, x: number, y: number, w: number, h: number, color = '#f6efdc') {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, w * 0.06);
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
    default:
      cross();
  }
  ctx.restore();
}

/** A NATO-style unit marker: framed, filled box with the symbol. Returns the canvas. */
export function markerCanvas(icon: string, fill: string, size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const w = size * 0.86, h = size * 0.58;
  const x = (size - w) / 2, y = (size - h) / 2 + size * 0.06;
  // Facing notch: the top of the marker points toward the unit's front.
  ctx.fillStyle = '#f6efdc';
  ctx.beginPath();
  ctx.moveTo(size / 2, y - size * 0.2);
  ctx.lineTo(size / 2 - size * 0.1, y - size * 0.02);
  ctx.lineTo(size / 2 + size * 0.1, y - size * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#141414';
  ctx.lineWidth = size * 0.05;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x, y, w, h);
  drawSymbol(ctx, icon, x + w * 0.12, y + h * 0.16, w * 0.76, h * 0.68);
  return c;
}

/** Just the symbol on transparency, for the top face of a block. */
export function topIconCanvas(icon: string, size = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(20, 18, 14, 0.55)';
  ctx.fillRect(size * 0.06, size * 0.2, size * 0.88, size * 0.6);
  drawSymbol(ctx, icon, size * 0.16, size * 0.27, size * 0.68, size * 0.46);
  return c;
}
