import { buildPartDrawingSheet } from './studio-part-drawing.js';

export const STUDIO_DRAWING_SVG_SCHEMA = 'partmode.drawing-svg/v1';
export const STUDIO_DRAWING_SVG_SCALES = Object.freeze([10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]);

export class StudioDrawingSvgError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioDrawingSvgError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new StudioDrawingSvgError(code, message);
}

const fmt = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) fail('DRAWING_SVG_INVALID', 'Drawing SVG received a non-finite value.');
  const rounded = Math.round(number * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const short = (value, limit) => {
  const text = String(value ?? '');
  return text.length <= limit ? text : text.slice(0, Math.max(1, limit - 1)) + '...';
};

function exactViews(response) {
  if (!response || response.kind !== 'drawing-result' || response.errors?.length || response.manifest?.exactProjectionEvidence?.kind !== 'occt-hlr-exact') {
    fail('DRAWING_SVG_EXACT_REQUIRED', 'Drawing SVG requires a successful exact OCCT HLR result.');
  }
  if (!Array.isArray(response.views) || response.views.length !== 4) fail('DRAWING_SVG_VIEW_SET_INVALID', 'Drawing SVG requires exactly four standard views.');
  const byView = new Map();
  let pathCount = 0;
  let pathCharacters = 0;
  for (const source of response.views) {
    const view = String(source?.view || '');
    const viewBox = Array.isArray(source?.viewBox) ? source.viewBox.map(Number) : [];
    const visible = Array.isArray(source?.visible) ? source.visible.map(String) : [];
    const hidden = Array.isArray(source?.hidden) ? source.hidden.map(String) : [];
    if (!['front', 'top', 'right', 'iso'].includes(view) || byView.has(view) || viewBox.length !== 4
      || viewBox.some((entry) => !Number.isFinite(entry)) || viewBox[2] <= 0 || viewBox[3] <= 0 || !visible.length
      || [...visible, ...hidden].some((entry) => !entry.trim() || entry.length > 1_000_000)) {
      fail('DRAWING_SVG_VIEW_SET_INVALID', 'Drawing SVG view identity, bounds, or exact paths are invalid.');
    }
    pathCount += visible.length + hidden.length;
    pathCharacters += [...visible, ...hidden].reduce((sum, entry) => sum + entry.length, 0);
    if (pathCount > 100_000 || pathCharacters > 16 * 1024 * 1024) fail('DRAWING_SVG_LIMIT_EXCEEDED', 'Drawing SVG exact paths exceed the bounded output limit.');
    byView.set(view, { view, viewBox, visible, hidden });
  }
  if (['front', 'top', 'right', 'iso'].some((view) => !byView.has(view))) fail('DRAWING_SVG_VIEW_SET_INVALID', 'Drawing SVG standard view set is incomplete.');
  return byView;
}

export function createStudioDrawingSvg(response, partName = 'Part', options = {}) {
  const persisted = buildPartDrawingSheet(response, partName);
  if (persisted) return persisted;
  const byView = exactViews(response);
  const front = byView.get('front');
  const top = byView.get('top');
  const right = byView.get('right');
  const iso = byView.get('iso');
  const sheetW = 297;
  const sheetH = 210;
  const margin = 12;
  const gap = 18;
  const fw = front.viewBox[2];
  const fh = front.viewBox[3];
  const th = top.viewBox[3];
  const rw = right.viewBox[2];
  const rawScale = Math.min(
    (sheetW - margin * 2 - 70 - gap - 26) / Math.max(1e-6, fw + rw),
    (sheetH - margin * 2 - gap - 34) / Math.max(1e-6, fh + th),
  );
  const scale = STUDIO_DRAWING_SVG_SCALES.find((value) => value <= rawScale) || STUDIO_DRAWING_SVG_SCALES.at(-1);
  const parts = [];
  const placedViews = new Map();
  const placeView = (entry, x, y) => {
    const width = entry.viewBox[2] * scale;
    const height = entry.viewBox[3] * scale;
    const paths = (dashed) => (dashed ? entry.hidden : entry.visible)
      .map((path) => `<path d="${esc(path)}" fill="none" stroke="#1c2733" stroke-width="${dashed ? 0.18 / scale : 0.35 / scale}"${dashed ? ` stroke-dasharray="${1.8 / scale} ${1.2 / scale}" stroke-opacity="0.55"` : ''}/>`)
      .join('');
    parts.push(`<svg data-exact-view="${entry.view}" x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(height)}" viewBox="${entry.viewBox.map(fmt).join(' ')}" preserveAspectRatio="xMidYMid meet">${paths(true)}${paths(false)}</svg>`);
    const placed = { x, y, width, height, viewBox: entry.viewBox };
    placedViews.set(entry.view, placed);
    return placed;
  };
  const dimensionHorizontal = (x0, x1, y, value, id) => {
    parts.push(`<g data-auto-dimension="${id}" stroke="#31547a" stroke-width="0.25" fill="none"><line x1="${fmt(x0)}" y1="${fmt(y)}" x2="${fmt(x1)}" y2="${fmt(y)}" marker-start="url(#da)" marker-end="url(#db)"/><line x1="${fmt(x0)}" y1="${fmt(y - 2)}" x2="${fmt(x0)}" y2="${fmt(y + 2)}"/><line x1="${fmt(x1)}" y1="${fmt(y - 2)}" x2="${fmt(x1)}" y2="${fmt(y + 2)}"/></g><text x="${fmt((x0 + x1) / 2)}" y="${fmt(y - 1.2)}" font-size="3.2" text-anchor="middle" fill="#1c2733" font-family="Arial,sans-serif">${fmt(value)}</text>`);
  };
  const dimensionVertical = (x, y0, y1, value, id) => {
    parts.push(`<g data-auto-dimension="${id}" stroke="#31547a" stroke-width="0.25" fill="none"><line x1="${fmt(x)}" y1="${fmt(y0)}" x2="${fmt(x)}" y2="${fmt(y1)}" marker-start="url(#da)" marker-end="url(#db)"/><line x1="${fmt(x - 2)}" y1="${fmt(y0)}" x2="${fmt(x + 2)}" y2="${fmt(y0)}"/><line x1="${fmt(x - 2)}" y1="${fmt(y1)}" x2="${fmt(x + 2)}" y2="${fmt(y1)}"/></g><text x="${fmt(x + 1.4)}" y="${fmt((y0 + y1) / 2)}" font-size="3.2" fill="#1c2733" font-family="Arial,sans-serif" transform="rotate(90 ${fmt(x + 1.4)} ${fmt((y0 + y1) / 2)})" text-anchor="middle">${fmt(value)}</text>`);
  };
  const frontX = margin + 14;
  const frontY = sheetH - margin - 30 - fh * scale;
  const frontRect = placeView(front, frontX, frontY);
  placeView(top, frontX, frontY - gap - th * scale);
  placeView(right, frontRect.x + frontRect.width + gap, frontY + fh * scale - right.viewBox[3] * scale);
  placeView(iso, sheetW - margin - 66, margin + 6);
  dimensionHorizontal(frontRect.x, frontRect.x + frontRect.width, frontRect.y + frontRect.height + 7, fw, 'front-width');
  dimensionVertical(frontRect.x + frontRect.width + rw * scale + gap + 7, frontRect.y, frontRect.y + frontRect.height, fh, 'front-height');
  dimensionVertical(frontRect.x - 7, frontY - gap - th * scale, frontY - gap, th, 'top-depth');

  const sheetPoint = (placed, point) => [
    placed.x + (Number(point?.[0]) - placed.viewBox[0]) * scale,
    placed.y + (Number(point?.[1]) - placed.viewBox[1]) * scale,
  ];
  const balloons = response.manifest?.annotations?.balloons || response.manifest?.drawingPlan?.annotations?.balloons || [];
  if (!Array.isArray(balloons) || balloons.length > 100) fail('DRAWING_SVG_LIMIT_EXCEEDED', 'Drawing SVG supports at most 100 exact balloons.');
  for (const balloon of balloons) {
    const placed = placedViews.get(balloon.view);
    if (!placed || !Array.isArray(balloon.anchor) || !Array.isArray(balloon.label)) continue;
    const anchor = sheetPoint(placed, balloon.anchor);
    const label = sheetPoint(placed, balloon.label);
    const leader = Array.isArray(balloon.leader) ? balloon.leader.map((point) => sheetPoint(placed, point)) : [anchor];
    const points = [...leader, label].map((point) => `${fmt(point[0])},${fmt(point[1])}`).join(' ');
    parts.push(`<g class="assembly-balloon" data-bom-item="${esc(balloon.itemNumber)}" fill="none" stroke="#31547a" stroke-width="0.35"><polyline points="${points}"/><circle cx="${fmt(label[0])}" cy="${fmt(label[1])}" r="3.6" fill="#fff"/><text x="${fmt(label[0])}" y="${fmt(label[1] + 1.05)}" text-anchor="middle" fill="#1c2733" stroke="none" font-size="3.2" font-weight="700" font-family="Arial,sans-serif">${esc(balloon.itemNumber)}</text></g>`);
  }
  const bom = response.manifest?.bom || [];
  if (!Array.isArray(bom) || bom.length > 100) fail('DRAWING_SVG_LIMIT_EXCEEDED', 'Drawing SVG supports at most 100 BOM rows.');
  if (bom.length) {
    const tableWidth = 92;
    const tableX = sheetW - margin - tableWidth;
    const rowHeight = Math.min(5, Math.max(20, sheetH - margin - 24 - margin - 3) / (bom.length + 1));
    const tableHeight = rowHeight * (bom.length + 1);
    const tableY = sheetH - margin - 24 - tableHeight - 2;
    const columns = [0, 8, 34, 70, 79, 92];
    parts.push(`<g class="assembly-bom" data-bom-rows="${bom.length}" font-family="Arial,sans-serif" fill="#1c2733"><rect x="${fmt(tableX)}" y="${fmt(tableY)}" width="${tableWidth}" height="${fmt(tableHeight)}" fill="#fff" stroke="#1c2733" stroke-width="0.35"/>${columns.slice(1, -1).map((offset) => `<line x1="${fmt(tableX + offset)}" y1="${fmt(tableY)}" x2="${fmt(tableX + offset)}" y2="${fmt(tableY + tableHeight)}" stroke="#1c2733" stroke-width="0.2"/>`).join('')}${Array.from({ length: bom.length }, (_, index) => `<line x1="${fmt(tableX)}" y1="${fmt(tableY + rowHeight * (index + 1))}" x2="${fmt(tableX + tableWidth)}" y2="${fmt(tableY + rowHeight * (index + 1))}" stroke="#1c2733" stroke-width="0.2"/>`).join('')}<g font-size="${fmt(Math.max(1.8, Math.min(2.6, rowHeight * 0.55)))}" font-weight="700"><text x="${fmt(tableX + 1)}" y="${fmt(tableY + rowHeight * 0.7)}">ITEM</text><text x="${fmt(tableX + 9)}" y="${fmt(tableY + rowHeight * 0.7)}">PART NUMBER</text><text x="${fmt(tableX + 35)}" y="${fmt(tableY + rowHeight * 0.7)}">DESCRIPTION</text><text x="${fmt(tableX + 71)}" y="${fmt(tableY + rowHeight * 0.7)}">QTY</text><text x="${fmt(tableX + 80)}" y="${fmt(tableY + rowHeight * 0.7)}">REV</text></g>${bom.map((entry, index) => { const y = tableY + rowHeight * (index + 1.7); return `<g data-bom-item="${esc(entry.itemNumber)}" font-size="${fmt(Math.max(1.7, Math.min(2.7, rowHeight * 0.58)))}"><text x="${fmt(tableX + 1)}" y="${fmt(y)}">${esc(entry.itemNumber)}</text><text x="${fmt(tableX + 9)}" y="${fmt(y)}">${esc(short(entry.partNumber, 18))}</text><text x="${fmt(tableX + 35)}" y="${fmt(y)}">${esc(short(entry.description, 28))}</text><text x="${fmt(tableX + 71)}" y="${fmt(y)}">${esc(entry.quantity)}</text><text x="${fmt(tableX + 80)}" y="${fmt(y)}">${esc(short(entry.revision, 8))}</text></g>`; }).join('')}</g>`);
  }
  const scaleLabel = scale >= 1 ? `${fmt(scale)}:1` : `1:${fmt(1 / scale)}`;
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(options.date || '') ? options.date : new Date().toISOString().slice(0, 10);
  const blockX = sheetW - margin - 92;
  const blockY = sheetH - margin - 24;
  const block = `<g font-family="Arial,sans-serif" fill="#1c2733"><rect x="${blockX}" y="${blockY}" width="92" height="24" fill="none" stroke="#1c2733" stroke-width="0.4"/><line x1="${blockX}" y1="${blockY + 8}" x2="${sheetW - margin}" y2="${blockY + 8}" stroke="#1c2733" stroke-width="0.25"/><line x1="${blockX}" y1="${blockY + 16}" x2="${sheetW - margin}" y2="${blockY + 16}" stroke="#1c2733" stroke-width="0.25"/><text x="${blockX + 3}" y="${blockY + 5.5}" font-size="3.6" font-weight="600">${esc(partName)}</text><text x="${blockX + 3}" y="${blockY + 13.5}" font-size="3">Scale ${scaleLabel} | millimetres | third angle</text><text x="${blockX + 3}" y="${blockY + 21.5}" font-size="3">PartMode | ${date}</text></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" viewBox="0 0 297 210" data-drawing-schema="${STUDIO_DRAWING_SVG_SCHEMA}" data-projection="third-angle" data-scale="${scaleLabel}"><defs><marker id="da" markerWidth="6" markerHeight="6" refX="1" refY="3" orient="auto"><path d="M6 0.6 1 3l5 2.4z" fill="#31547a"/></marker><marker id="db" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0.6 5 3 0 5.4z" fill="#31547a"/></marker></defs><rect width="297" height="210" fill="#fff"/><rect x="6" y="6" width="285" height="198" fill="none" stroke="#1c2733" stroke-width="0.5"/>${parts.join('')}${block}</svg>`;
}
