// Narrow, fail-closed renderer for persisted schema-5 part drawing recipes.
// Exact projected paths come from OCCT HLR in the worker. The longitudinal
// section is generated from the same evaluated profile sketch that creates the
// revolved B-rep, so configuration changes drive both the solid and the sheet.

const esc = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const number = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Part drawing contains a non-finite numeric value.');
  return parsed;
};

const fmt = (value) => {
  const rounded = Math.round(number(value) * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

const svgPath = (points) => points.map((point, index) =>
  (index ? 'L' : 'M') + fmt(point[0]) + ' ' + fmt(point[1])).join(' ') + ' Z';

function dimensionText(dimension) {
  const symbol = dimension.kind === 'diameter' ? '⌀' : dimension.kind === 'radius' ? 'R ' : '';
  if (Array.isArray(dimension.limits)) return `${dimension.id}  ${symbol}${dimension.limits[0]}–${dimension.limits[1]}`;
  if (dimension.minimum != null) return `${dimension.id}  ${symbol}${dimension.minimum} MIN`;
  const basic = dimension.basic ?? dimension.value ?? '';
  if (dimension.tolerance?.plusMinus != null) return `${dimension.id}  ${symbol}${basic} ±${dimension.tolerance.plusMinus}`;
  if (dimension.tolerance?.upper != null || dimension.tolerance?.lower != null) {
    const upper = dimension.tolerance?.upper ?? '.000';
    const lower = dimension.tolerance?.lower ?? '.000';
    return `${dimension.id}  ${symbol}${basic} +${String(upper).replace(/^\+/, '')}/${String(lower).startsWith('-') ? lower : '-' + lower}`;
  }
  return `${dimension.id}  ${symbol}${basic}`;
}

function projectionSvg(entry, box, label) {
  if (!entry) throw new Error(`Required exact projection "${label}" is missing.`);
  const visible = entry.visible.map((d) => `<path d="${esc(d)}" class="visible"/>`).join('');
  const hidden = entry.hidden.map((d) => `<path d="${esc(d)}" class="hidden"/>`).join('');
  return `<g data-exact-view="${esc(entry.view)}">`
    + `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" class="view-frame"/>`
    + `<svg x="${box.x + 3}" y="${box.y + 3}" width="${box.w - 6}" height="${box.h - 10}" viewBox="${entry.viewBox.map(fmt).join(' ')}" preserveAspectRatio="xMidYMid meet">${hidden}${visible}</svg>`
    + `<text x="${box.x + box.w / 2}" y="${box.y + box.h - 2.5}" class="view-label" text-anchor="middle">${esc(label)}</text>`
    + '</g>';
}

function sectionGeometry(profile, box) {
  if (!Array.isArray(profile) || profile.length < 4) throw new Error('Part drawing section profile is incomplete.');
  const points = profile.map((point) => [number(point[0]), number(point[1])]);
  if (points.some((point) => point[1] < 0)) throw new Error('Part drawing section profile radii must be non-negative.');
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const maxR = Math.max(...points.map((point) => point[1]));
  if (!(maxX > minX) || !(maxR > 0)) throw new Error('Part drawing section profile has no drawable extent.');
  const scale = Math.min((box.w - 18) / (maxX - minX), (box.h - 20) / (maxR * 2));
  const centerY = box.y + box.h / 2;
  const startX = box.x + 9 + (box.w - 18 - (maxX - minX) * scale) / 2;
  const map = (point, sign) => [startX + (point[0] - minX) * scale, centerY + sign * point[1] * scale];
  const upper = points.map((point) => map(point, -1));
  const lower = points.map((point) => map(point, 1));
  const mapX = (x) => startX + (x - minX) * scale;
  const mapR = (x, radius, sign = -1) => [mapX(x), centerY + sign * radius * scale];
  return { points, minX, maxX, maxR, scale, centerY, startX, upper, lower, mapX, mapR };
}

function linearDimension(x0, x1, y, label, offset = 0) {
  const lineY = y + offset;
  return `<g class="dimension"><line x1="${fmt(x0)}" y1="${fmt(lineY)}" x2="${fmt(x1)}" y2="${fmt(lineY)}" marker-start="url(#arrow-in)" marker-end="url(#arrow-out)"/>`
    + `<line x1="${fmt(x0)}" y1="${fmt(lineY - 2)}" x2="${fmt(x0)}" y2="${fmt(lineY + 2)}"/><line x1="${fmt(x1)}" y1="${fmt(lineY - 2)}" x2="${fmt(x1)}" y2="${fmt(lineY + 2)}"/>`
    + `<text x="${fmt((x0 + x1) / 2)}" y="${fmt(lineY - 1.2)}" text-anchor="middle">${esc(label)}</text></g>`;
}

function leader(anchor, label, dx, dy) {
  const end = [anchor[0] + dx, anchor[1] + dy];
  const elbow = [anchor[0] + dx * 0.55, end[1]];
  const textAnchor = dx < 0 ? 'end' : 'start';
  const textX = end[0] + (dx < 0 ? -1 : 1);
  return `<g class="leader"><polyline points="${anchor.map(fmt).join(',')} ${elbow.map(fmt).join(',')} ${end.map(fmt).join(',')}"/>`
    + `<text x="${fmt(textX)}" y="${fmt(end[1] - 0.7)}" text-anchor="${textAnchor}">${esc(label)}</text></g>`;
}

function findDimension(drawing, id) {
  const dimension = drawing.dimensions.find((entry) => entry.id === id);
  if (!dimension) throw new Error(`Part drawing dimension "${id}" is missing.`);
  return dimension;
}

function inchValue(dimension) {
  if (dimension.basic != null) return number(dimension.basic);
  if (dimension.minimum != null) return number(dimension.minimum);
  if (Array.isArray(dimension.limits)) return (number(dimension.limits[0]) + number(dimension.limits[1])) / 2;
  return number(dimension.value);
}

export function buildPartDrawingSheet(response, partName = 'Part') {
  const drawing = response?.manifest?.partDrawing;
  if (!drawing) return null;
  if (drawing.schema !== 'partmode.part-drawing/v1') throw new Error('Part drawing schema is unsupported.');
  if (drawing.displayUnits !== 'in') throw new Error('This drawing renderer currently requires authored inch dimensions.');
  if (!drawing.configuration?.id || drawing.configuration.id !== response.manifest.configuration?.id) {
    throw new Error('Part drawing configuration evidence is missing or stale.');
  }
  if (!drawing.effectiveDocumentHash || drawing.effectiveDocumentHash !== response.manifest.effectiveDocumentHash) {
    throw new Error('Part drawing effective-document evidence is missing or stale.');
  }
  if (response.manifest.exactProjectionEvidence?.kind !== 'occt-hlr-exact'
    || response.manifest.exactProjectionEvidence.effectiveDocumentHash !== drawing.effectiveDocumentHash) {
    throw new Error('Part drawing requires exact OCCT HLR evidence for the effective configuration.');
  }
  const byView = new Map(response.views.map((entry) => [entry.view, entry]));
  for (const required of drawing.requiredViews) if (!byView.has(required)) {
    throw new Error(`Required exact projection "${required}" is missing.`);
  }
  const sheetW = 420;
  const sheetH = 297;
  const border = 7;
  const sectionBox = { x: 15, y: 38, w: 250, h: 116 };
  const section = sectionGeometry(drawing.sectionProfileMm, sectionBox);
  const dimensions = Object.fromEntries(drawing.dimensions.map((entry) => [entry.id, entry]));
  for (const id of ['A', 'B', 'C', 'D', 'F', 'G', 'H', 'J', 'L', 'M', 'W']) findDimension(drawing, id);
  const Bmm = inchValue(dimensions.B) * 25.4;
  const Jmm = inchValue(dimensions.J) * 25.4;
  const Mmm = inchValue(dimensions.M) * 25.4;
  const sectionParts = [
    `<rect x="${sectionBox.x}" y="${sectionBox.y}" width="${sectionBox.w}" height="${sectionBox.h}" class="view-frame"/>`,
    `<path d="${svgPath(section.upper)}" class="section-material" data-profile-half="upper"/>`,
    `<path d="${svgPath(section.lower)}" class="section-material" data-profile-half="lower"/>`,
    `<line x1="${fmt(section.startX - 5)}" y1="${fmt(section.centerY)}" x2="${fmt(section.mapX(section.maxX) + 5)}" y2="${fmt(section.centerY)}" class="centerline"/>`,
    `<text x="${sectionBox.x + sectionBox.w / 2}" y="${sectionBox.y + sectionBox.h + 5}" class="view-label" text-anchor="middle">LONGITUDINAL SECTION A-A · CONFIGURATION-DRIVEN PROFILE</text>`,
    linearDimension(section.mapX(0), section.mapX(Bmm), sectionBox.y + sectionBox.h + 11, `B ${dimensionText(dimensions.B).replace(/^B\s+/, '')}`),
    linearDimension(section.mapX(Bmm), section.mapX(Bmm + Jmm), sectionBox.y + sectionBox.h + 17, `J ${dimensionText(dimensions.J).replace(/^J\s+/, '')}`),
    linearDimension(section.mapX(Bmm + Jmm), section.mapX(Bmm + Jmm + Mmm), sectionBox.y + sectionBox.h + 23, `M ${dimensionText(dimensions.M).replace(/^M\s+/, '')}`),
  ];
  const profile = section.points;
  sectionParts.push(
    leader(section.mapR(profile[0][0], profile[0][1]), dimensionText(dimensions.D), -27, -15),
    leader(section.mapR(profile[2][0], profile[2][1]), dimensionText(dimensions.C), -6, -12),
    leader(section.mapR(profile[3][0], profile[3][1]), dimensionText(dimensions.F), 16, -5),
    leader(section.mapR(profile[6][0], profile[6][1]), dimensionText(dimensions.L), 25, 4),
    leader(section.mapR(profile.at(-1)[0], profile.at(-1)[1]), dimensionText(dimensions.A), -35, 15),
  );
  const fullThreadStartMm = Bmm + (Jmm - inchValue(dimensions.G) * 25.4);
  sectionParts.push(
    linearDimension(section.mapX(fullThreadStartMm), section.mapX(Bmm + Jmm), sectionBox.y + 5, `G ${dimensions.G.minimum} MIN FULL THREAD`),
    leader(section.mapR(Bmm + Jmm * 0.55, Math.max(...profile.map((point) => point[1]))), `${drawing.threadDesignation} · ${drawing.threadStandard}`, 25, -2),
    leader(section.mapR(profile[1][0], profile[1][1]), `W ${dimensions.W.minimum} MIN · SEALING SURFACE 63 µin Ra`, 28, 18),
    leader(section.mapR(profile[2][0], profile[2][1]), drawing.symbols.sealingAngle, 18, 18),
  );

  const tableX = 279;
  const tableY = 151;
  const tableW = 132;
  const rowH = 6;
  const tableColumnX = tableX + 19;
  const tableHeight = rowH * (drawing.dimensions.length + 1);
  const tableRows = drawing.dimensions.map((dimension, index) => {
    const y = tableY + rowH * (index + 2);
    return `<line x1="${tableX}" y1="${fmt(y)}" x2="${tableX + tableW}" y2="${fmt(y)}" class="thin"/>`
      + `<text x="${tableX + 2}" y="${fmt(y - 1.5)}" class="table-text">${esc(dimension.id)}</text>`
      + `<text x="${tableColumnX + 2}" y="${fmt(y - 1.5)}" class="table-text">${esc(dimensionText(dimension).replace(new RegExp('^' + dimension.id + '\\s+'), ''))}</text>`;
  }).join('');
  const notes = drawing.notes.map((note, index) =>
    `<text x="17" y="${fmt(207 + index * 6)}" class="note"><tspan font-weight="700">${index + 1}.</tspan> ${esc(note.text)}</text>`).join('');
  const limitations = drawing.limitations.map((text, index) =>
    `<text x="17" y="${fmt(255 + index * 5)}" class="limitation">${esc(text)}</text>`).join('');
  const right = projectionSvg(byView.get('right'), { x: 278, y: 38, w: 61, h: 53 }, 'END VIEW · EXACT HLR');
  const iso = projectionSvg(byView.get('iso'), { x: 345, y: 38, w: 66, h: 53 }, 'ISOMETRIC · EXACT HLR');
  const front = projectionSvg(byView.get('front'), { x: 278, y: 96, w: 133, h: 48 }, 'FRONT · EXACT HLR CHECK');
  const titleY = 267;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}mm" height="${sheetH}mm" viewBox="0 0 ${sheetW} ${sheetH}" data-drawing-schema="${esc(drawing.schema)}" data-configuration-id="${esc(drawing.configuration.id)}" data-effective-document-hash="${esc(drawing.effectiveDocumentHash)}">`
    + '<defs>'
    + '<pattern id="section-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="#5a6d7e" stroke-width=".35"/></pattern>'
    + '<marker id="arrow-in" markerWidth="5" markerHeight="5" refX="1" refY="2.5" orient="auto"><path d="M5 .5 1 2.5 5 4.5z" fill="#243f5b"/></marker>'
    + '<marker id="arrow-out" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 .5 4 2.5 0 4.5z" fill="#243f5b"/></marker>'
    + '<style>.visible{fill:none;stroke:#16212c;stroke-width:.35;vector-effect:non-scaling-stroke}.hidden{fill:none;stroke:#627383;stroke-width:.2;stroke-dasharray:1.8 1.2;vector-effect:non-scaling-stroke}.view-frame{fill:none;stroke:#9aa7b1;stroke-width:.25}.view-label,.table-head,.table-text,.note,.limitation,.title,.subtitle,.dimension text,.leader text{font-family:Arial,sans-serif;fill:#172330}.view-label{font-size:2.7;font-weight:700}.section-material{fill:url(#section-hatch);stroke:#111d28;stroke-width:.45}.centerline{stroke:#46627c;stroke-width:.22;stroke-dasharray:7 1.5 1.5 1.5}.dimension,.leader{fill:none;stroke:#243f5b;stroke-width:.25}.dimension text,.leader text{fill:#172330;stroke:none;font-size:2.8}.thin{stroke:#51606d;stroke-width:.2}.table-head{font-size:3;font-weight:700}.table-text{font-size:2.75}.note{font-size:2.75}.limitation{font-size:2.45;fill:#8b2e2e}.title{font-size:4.2;font-weight:700}.subtitle{font-size:2.8}.border{fill:#fff;stroke:#172330;stroke-width:.5}.fcf{fill:none;stroke:#172330;stroke-width:.35}.flag{fill:#fff6da;stroke:#a27118;stroke-width:.3}</style>'
    + '</defs>'
    + `<rect width="${sheetW}" height="${sheetH}" fill="#fff"/><rect x="${border}" y="${border}" width="${sheetW - border * 2}" height="${sheetH - border * 2}" class="border"/>`
    + `<text x="15" y="18" class="title">${esc(drawing.standard)} · STYLE ${esc(drawing.style)} · SIZE ${esc(drawing.sizeCode)}</text>`
    + `<text x="15" y="24" class="subtitle">${esc(drawing.callout)} · NOMINAL ENVELOPE MODEL · DRAWING UNITS: INCHES</text>`
    + `<rect x="15" y="28" width="250" height="7" class="flag"/><text x="18" y="32.8" class="subtitle">CONFIGURATION ${esc(drawing.configuration.name)} · ${esc(drawing.complianceStatus.toUpperCase())}</text>`
    + sectionParts.join('') + right + iso + front
    + `<rect x="${tableX}" y="${tableY}" width="${tableW}" height="${tableHeight}" fill="none" stroke="#172330" stroke-width=".4"/>`
    + `<line x1="${tableColumnX}" y1="${tableY}" x2="${tableColumnX}" y2="${tableY + tableHeight}" class="thin"/>`
    + `<text x="${tableX + 2}" y="${tableY + 4}" class="table-head">DIMENSION</text><text x="${tableColumnX + 2}" y="${tableY + 4}" class="table-head">ACTIVE CONFIGURATION VALUE / TOLERANCE (IN)</text>`
    + `<line x1="${tableX}" y1="${tableY + rowH}" x2="${tableX + tableW}" y2="${tableY + rowH}" class="thin"/>${tableRows}`
    + `<text x="15" y="199" class="table-head">NOTES</text>${notes}`
    + `<g transform="translate(279 233)"><text x="0" y="0" class="table-head">MANUFACTURING CALLOUTS</text><rect x="0" y="4" width="132" height="25" class="fcf"/>`
    + `<text x="3" y="10" class="table-text">THREAD  ${esc(drawing.threadDesignation)} · ${esc(drawing.threadStandard)}</text>`
    + `<text x="3" y="16" class="table-text">SURFACE  ⌯ ${esc(drawing.symbols.sealingSurfaceFinishMicroinchRa)} µin Ra</text>`
    + `<text x="3" y="22" class="table-text">CIRCULAR RUNOUT | ${esc(drawing.symbols.runout.value)} | DATUM ${esc(drawing.symbols.runout.datum)}</text>`
    + `<rect x="112" y="17" width="8" height="8" class="fcf"/><text x="116" y="23" class="table-head" text-anchor="middle">A</text></g>`
    + limitations
    + `<g><rect x="${sheetW - border - 152}" y="${titleY}" width="152" height="23" class="fcf"/><line x1="${sheetW - border - 152}" y1="${titleY + 8}" x2="${sheetW - border}" y2="${titleY + 8}" class="thin"/><line x1="${sheetW - border - 152}" y1="${titleY + 16}" x2="${sheetW - border}" y2="${titleY + 16}" class="thin"/>`
    + `<text x="${sheetW - border - 149}" y="${titleY + 5.5}" class="title">${esc(drawing.partNumber)}</text>`
    + `<text x="${sheetW - border - 149}" y="${titleY + 13.5}" class="subtitle">${esc(partName)} · REV B · THIRD ANGLE</text>`
    + `<text x="${sheetW - border - 149}" y="${titleY + 21}" class="subtitle">PartMode · ${esc(drawing.authoredDate)} · ${esc(drawing.configuration.id)}</text></g>`
    + '</svg>';
}
