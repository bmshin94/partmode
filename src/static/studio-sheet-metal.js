export const STUDIO_SHEET_METAL_SCHEMA = 'partmode.sheet-metal/v1';
export const STUDIO_SHEET_METAL_FEATURE_TYPE = 'sheet-metal-flange';
export const STUDIO_SHEET_METAL_KINDS = Object.freeze(['base-flange', 'edge-flange', 'corner-relief', 'flat-pattern']);
export const STUDIO_SHEET_METAL_EDGE_SIDES = Object.freeze(['up', 'down']);
export const STUDIO_SHEET_METAL_RELIEF_STYLES = Object.freeze(['rectangular', 'circular']);
export const STUDIO_SHEET_METAL_BEND_ANGLE_DEGREES = 90;
export const STUDIO_SHEET_METAL_PROFILE_ID = 'sheet-profile';
export const STUDIO_SHEET_METAL_BEND_TABLE_KIND = 'bend-table';

export const STUDIO_SHEET_METAL_LIMITS = Object.freeze({
  thickness: Object.freeze({ minimum: 0.05, maximum: 100 }),
  bendRadius: Object.freeze({ minimum: 0.05, maximum: 1000 }),
  kFactor: Object.freeze({ minimum: 0.01, maximum: 1 }),
  flangeLength: Object.freeze({ minimum: 0.05, maximum: 10_000 }),
  profilePoints: Object.freeze({ minimum: 3, maximum: 64 }),
  bendTableRows: Object.freeze({ minimum: 1, maximum: 64 }),
});

export const STUDIO_SHEET_METAL_BASE_POLICY = 'single-closed-profile-flat-sheet';
export const STUDIO_SHEET_METAL_EDGE_POLICY = 'single-full-edge-90-degree-bend';
export const STUDIO_SHEET_METAL_RELIEF_POLICY = 'single-90-degree-shared-corner-base-cutout';
export const STUDIO_SHEET_METAL_FLAT_POLICY = 'derived-read-only-exact-flat-pattern';
export const STUDIO_SHEET_METAL_COMPLIANCE =
  'k-factor-neutral-axis-design-aid-not-manufacturing-certification';

const EPSILON = 1e-9;
const clone = (value) => JSON.parse(JSON.stringify(value));
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record, key);

function exactKeys(record, keys, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(label + ' must be an object.');
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ' contains unsupported fields.');
}

function literalInRange(value, range, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < range.minimum || value > range.maximum) {
    throw new Error(label + ' must be a literal finite number between ' + range.minimum + ' and ' + range.maximum + ' mm-scale units.');
  }
  return value;
}

export function assertStudioSheetMetalId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id) || id.length > 120) {
    throw new Error('Sheet-metal feature ID must contain 1 to 120 safe identifier characters.');
  }
  return id;
}

// Exact closed-form bend allowance along the neutral fiber:
//   BA = (innerRadius + kFactor * thickness) * angleInRadians
// This is the only sanctioned derivation. Stored bendAllowance values must
// equal this function's output exactly; any mismatch is a tampered document.
export function studioSheetMetalBendAllowance(bendRadius, kFactor, thickness, angleDegrees) {
  const radius = Number(bendRadius);
  const factor = Number(kFactor);
  const sheet = Number(thickness);
  const angle = Number(angleDegrees);
  if (![radius, factor, sheet, angle].every(Number.isFinite) || radius <= 0 || factor <= 0 || sheet <= 0 || angle <= 0) {
    throw new Error('Bend allowance requires finite positive bend radius, K-factor, thickness, and angle.');
  }
  return (radius + factor * sheet) * (angle * Math.PI / 180);
}

// Exact corner-relief sizing. The relief square side (or quarter-circle
// radius) is exactly the base flange's stored default bend radius plus the
// sheet thickness. This is the only sanctioned derivation; stored reliefSize
// values must equal this function's output exactly.
export function studioSheetMetalReliefSize(bendRadius, thickness) {
  const radius = Number(bendRadius);
  const sheet = Number(thickness);
  if (![radius, sheet].every(Number.isFinite) || radius <= 0 || sheet <= 0) {
    throw new Error('Corner relief size requires finite positive bend radius and thickness.');
  }
  return radius + sheet;
}

// Exact base-sheet area removed by one corner relief cutout: a full square for
// the rectangular style, a quarter disc for the circular style.
export function studioSheetMetalReliefArea(style, reliefSize) {
  if (!STUDIO_SHEET_METAL_RELIEF_STYLES.includes(style)) {
    throw new Error('Corner relief style must be rectangular or circular.');
  }
  const size = Number(reliefSize);
  if (!Number.isFinite(size) || size <= 0) throw new Error('Corner relief area requires a finite positive relief size.');
  return style === 'circular' ? (Math.PI / 4) * size * size : size * size;
}

// --- bend table -------------------------------------------------------------
// A part may store one bend table of exact K-factor rows keyed by the
// (thickness, bendRadius) pair. When the table is present it is the only
// K-factor source: flange creation and edits resolve against it with exact
// equality lookup and fail closed when the row is missing.

export function assertStudioSheetMetalBendTable(table, path = 'part.extensions.sheetMetalBendTable') {
  exactKeys(table, ['schema', 'version', 'kind', 'rows'], path);
  if (table.schema !== STUDIO_SHEET_METAL_SCHEMA || table.version !== 1
    || table.kind !== STUDIO_SHEET_METAL_BEND_TABLE_KIND) {
    throw new Error(path + ' bend-table schema identity is unsupported.');
  }
  const limits = STUDIO_SHEET_METAL_LIMITS.bendTableRows;
  if (!Array.isArray(table.rows) || table.rows.length < limits.minimum || table.rows.length > limits.maximum) {
    throw new Error(path + '.rows must contain ' + limits.minimum + ' to ' + limits.maximum + ' bend-table rows.');
  }
  table.rows.forEach((row, index) => {
    const rowPath = path + '.rows[' + index + ']';
    exactKeys(row, ['thickness', 'bendRadius', 'kFactor'], rowPath);
    literalInRange(row.thickness, STUDIO_SHEET_METAL_LIMITS.thickness, rowPath + ' thickness');
    literalInRange(row.bendRadius, STUDIO_SHEET_METAL_LIMITS.bendRadius, rowPath + ' bend radius');
    literalInRange(row.kFactor, STUDIO_SHEET_METAL_LIMITS.kFactor, rowPath + ' K-factor');
  });
  for (let index = 1; index < table.rows.length; index++) {
    const previous = table.rows[index - 1];
    const row = table.rows[index];
    if (previous.thickness > row.thickness
      || (previous.thickness === row.thickness && previous.bendRadius >= row.bendRadius)) {
      throw new Error(path + '.rows must be strictly sorted by thickness then bend radius with no duplicate pairs.');
    }
  }
  return clone(table);
}

export function studioSheetMetalBendTable(part) {
  const table = part?.extensions?.sheetMetalBendTable;
  if (table === undefined || table === null) return null;
  return assertStudioSheetMetalBendTable(table);
}

export function studioSheetMetalBendTableLookup(table, thickness, bendRadius, label = 'Sheet-metal flange') {
  const row = (table?.rows || []).find((entry) => entry.thickness === thickness && entry.bendRadius === bendRadius);
  if (!row) {
    throw new Error(label + ' resolves its K-factor against the stored bend table, which has no exact row for thickness '
      + thickness + ' and bend radius ' + bendRadius + '. Bend-table lookup fails closed; add the row or remove the table.');
  }
  return row.kFactor;
}

// Deterministic persistent creation names for the base-flange prism, shared by
// authoring (which stores them) and the production worker (which resolves the
// current exact topology through them, name-first, with no signature fallback).
export function studioSheetMetalSegmentEntityId(segmentIndex) {
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= STUDIO_SHEET_METAL_LIMITS.profilePoints.maximum) {
    throw new Error('Sheet-metal profile segment index must be an integer inside the profile bound.');
  }
  return STUDIO_SHEET_METAL_PROFILE_ID + ':segment:' + segmentIndex;
}

export function studioSheetMetalSideFaceName(baseFeatureId, segmentIndex) {
  assertStudioSheetMetalId(baseFeatureId);
  return 'F' + baseFeatureId + ':side:' + studioSheetMetalSegmentEntityId(segmentIndex);
}

export function studioSheetMetalCapFaceName(baseFeatureId, side) {
  assertStudioSheetMetalId(baseFeatureId);
  if (!STUDIO_SHEET_METAL_EDGE_SIDES.includes(side)) throw new Error('Sheet-metal bend side must be up or down.');
  return 'F' + baseFeatureId + ':cap:' + (side === 'up' ? 'end' : 'start');
}

export function studioSheetMetalBendEdgeName(baseFeatureId, segmentIndex, side) {
  const pair = [
    studioSheetMetalCapFaceName(baseFeatureId, side),
    studioSheetMetalSideFaceName(baseFeatureId, segmentIndex),
  ].sort();
  return 'E(' + pair[0] + '|' + pair[1] + ')';
}

export function studioSheetMetalBaseRecipe(featureId, profileSketchId, input) {
  assertStudioSheetMetalId(featureId);
  if (typeof profileSketchId !== 'string' || !profileSketchId) throw new Error('Base flange requires a profile sketch ID.');
  return {
    schema: STUDIO_SHEET_METAL_SCHEMA,
    version: 1,
    kind: 'base-flange',
    featureId,
    profileSketchId,
    thickness: literalInRange(input?.thickness, STUDIO_SHEET_METAL_LIMITS.thickness, 'Sheet thickness'),
    kFactor: literalInRange(input?.kFactor, STUDIO_SHEET_METAL_LIMITS.kFactor, 'K-factor'),
    bendRadius: literalInRange(input?.bendRadius, STUDIO_SHEET_METAL_LIMITS.bendRadius, 'Default bend radius'),
    flangePolicy: STUDIO_SHEET_METAL_BASE_POLICY,
    complianceStatus: STUDIO_SHEET_METAL_COMPLIANCE,
  };
}

export function studioSheetMetalEdgeRecipe(featureId, base, input) {
  assertStudioSheetMetalId(featureId);
  assertStudioSheetMetalId(base?.baseFeatureId);
  if (typeof base?.baseBodyId !== 'string' || !base.baseBodyId) throw new Error('Edge flange requires the base-flange body ID.');
  if (typeof base?.baseThickness !== 'number' || !Number.isFinite(base.baseThickness) || base.baseThickness <= 0) {
    throw new Error('Edge flange requires the current base-flange thickness.');
  }
  const segmentIndex = input?.segmentIndex;
  const side = input?.side;
  if (!STUDIO_SHEET_METAL_EDGE_SIDES.includes(side)) throw new Error('Sheet-metal bend side must be up or down.');
  const bendRadius = literalInRange(input?.bendRadius, STUDIO_SHEET_METAL_LIMITS.bendRadius, 'Bend radius');
  const kFactor = literalInRange(input?.kFactor, STUDIO_SHEET_METAL_LIMITS.kFactor, 'K-factor');
  const flangeLength = literalInRange(input?.flangeLength, STUDIO_SHEET_METAL_LIMITS.flangeLength, 'Flange length');
  return {
    schema: STUDIO_SHEET_METAL_SCHEMA,
    version: 1,
    kind: 'edge-flange',
    featureId,
    baseFeatureId: base.baseFeatureId,
    baseBodyId: base.baseBodyId,
    segmentIndex: (studioSheetMetalSegmentEntityId(segmentIndex), segmentIndex),
    side,
    bendAngleDegrees: STUDIO_SHEET_METAL_BEND_ANGLE_DEGREES,
    bendRadius,
    kFactor,
    flangeLength,
    bendAllowance: studioSheetMetalBendAllowance(
      bendRadius,
      kFactor,
      base.baseThickness,
      STUDIO_SHEET_METAL_BEND_ANGLE_DEGREES,
    ),
    edgeName: studioSheetMetalBendEdgeName(base.baseFeatureId, segmentIndex, side),
    sheetFaceName: studioSheetMetalCapFaceName(base.baseFeatureId, side),
    attachmentFaceName: studioSheetMetalSideFaceName(base.baseFeatureId, segmentIndex),
    flangePolicy: STUDIO_SHEET_METAL_EDGE_POLICY,
    complianceStatus: STUDIO_SHEET_METAL_COMPLIANCE,
  };
}

export function studioSheetMetalCornerRecipe(featureId, base, input) {
  assertStudioSheetMetalId(featureId);
  assertStudioSheetMetalId(base?.baseFeatureId);
  if (typeof base?.baseBodyId !== 'string' || !base.baseBodyId) throw new Error('Corner relief requires the base-flange body ID.');
  const cornerIndex = input?.cornerIndex;
  if (!Number.isInteger(cornerIndex) || cornerIndex < 0 || cornerIndex >= STUDIO_SHEET_METAL_LIMITS.profilePoints.maximum) {
    throw new Error('Corner relief corner index must be an integer inside the profile bound.');
  }
  if (!STUDIO_SHEET_METAL_RELIEF_STYLES.includes(input?.style)) {
    throw new Error('Corner relief style must be rectangular or circular.');
  }
  return {
    schema: STUDIO_SHEET_METAL_SCHEMA,
    version: 1,
    kind: 'corner-relief',
    featureId,
    baseFeatureId: base.baseFeatureId,
    baseBodyId: base.baseBodyId,
    cornerIndex,
    style: input.style,
    reliefSize: studioSheetMetalReliefSize(base?.baseBendRadius, base?.baseThickness),
    flangePolicy: STUDIO_SHEET_METAL_RELIEF_POLICY,
    complianceStatus: STUDIO_SHEET_METAL_COMPLIANCE,
  };
}

export function studioSheetMetalFlatRecipe(featureId, base) {
  assertStudioSheetMetalId(featureId);
  assertStudioSheetMetalId(base?.baseFeatureId);
  if (typeof base?.baseBodyId !== 'string' || !base.baseBodyId) throw new Error('Flat pattern requires the base-flange body ID.');
  return {
    schema: STUDIO_SHEET_METAL_SCHEMA,
    version: 1,
    kind: 'flat-pattern',
    featureId,
    baseFeatureId: base.baseFeatureId,
    baseBodyId: base.baseBodyId,
    flangePolicy: STUDIO_SHEET_METAL_FLAT_POLICY,
    complianceStatus: STUDIO_SHEET_METAL_COMPLIANCE,
  };
}

function referenceRole(reference, ownerKind, role) {
  return reference?.ownerKind === ownerKind
    && reference.semanticPath?.role === role
    && reference.signature?.role === role;
}

export function isStudioSheetMetalFeature(feature) {
  return Boolean(feature && feature.type === STUDIO_SHEET_METAL_FEATURE_TYPE && feature.extensions?.sheetMetal);
}

export function assertStudioSheetMetalFeature(feature, path = 'feature') {
  if (!feature || feature.type !== STUDIO_SHEET_METAL_FEATURE_TYPE) {
    throw new Error(path + ' must be a sheet-metal flange feature.');
  }
  const recipe = feature.extensions?.sheetMetal;
  if (!recipe || typeof recipe !== 'object') throw new Error(path + '.extensions.sheetMetal is required.');
  if (recipe.schema !== STUDIO_SHEET_METAL_SCHEMA || recipe.version !== 1) {
    throw new Error(path + ' sheet-metal schema is unsupported.');
  }
  if (!STUDIO_SHEET_METAL_KINDS.includes(recipe.kind)) throw new Error(path + ' sheet-metal kind is unsupported.');
  if (recipe.featureId !== feature.id) throw new Error(path + ' sheet-metal recipe is detached from its feature ID.');
  if (recipe.complianceStatus !== STUDIO_SHEET_METAL_COMPLIANCE) {
    throw new Error(path + ' sheet-metal compliance evidence is invalid.');
  }
  if (recipe.kind === 'base-flange') {
    exactKeys(recipe, [
      'schema', 'version', 'kind', 'featureId', 'profileSketchId', 'thickness', 'kFactor', 'bendRadius',
      'flangePolicy', 'complianceStatus',
    ], path + '.extensions.sheetMetal');
    if (recipe.flangePolicy !== STUDIO_SHEET_METAL_BASE_POLICY) throw new Error(path + ' base-flange policy evidence is invalid.');
    literalInRange(recipe.thickness, STUDIO_SHEET_METAL_LIMITS.thickness, path + ' sheet thickness');
    literalInRange(recipe.kFactor, STUDIO_SHEET_METAL_LIMITS.kFactor, path + ' K-factor');
    literalInRange(recipe.bendRadius, STUDIO_SHEET_METAL_LIMITS.bendRadius, path + ' default bend radius');
    if (typeof recipe.profileSketchId !== 'string' || !recipe.profileSketchId) {
      throw new Error(path + ' base flange requires a profile sketch reference.');
    }
    if (feature.resultPolicy?.kind !== 'new-body') throw new Error(path + ' base flange must create one new exact body.');
    if (!Array.isArray(feature.inputRefs) || feature.inputRefs.length !== 1
      || !referenceRole(feature.inputRefs[0], 'sketch', 'profile')
      || feature.inputRefs[0].ownerId !== recipe.profileSketchId) {
      throw new Error(path + ' base-flange inputs are detached from the authored profile sketch.');
    }
    return clone(recipe);
  }
  if (recipe.kind === 'corner-relief') {
    exactKeys(recipe, [
      'schema', 'version', 'kind', 'featureId', 'baseFeatureId', 'baseBodyId', 'cornerIndex', 'style',
      'reliefSize', 'flangePolicy', 'complianceStatus',
    ], path + '.extensions.sheetMetal');
    if (recipe.flangePolicy !== STUDIO_SHEET_METAL_RELIEF_POLICY) throw new Error(path + ' corner-relief policy evidence is invalid.');
    assertStudioSheetMetalId(recipe.baseFeatureId);
    if (typeof recipe.baseBodyId !== 'string' || !recipe.baseBodyId) throw new Error(path + ' corner relief requires its base body reference.');
    if (!Number.isInteger(recipe.cornerIndex) || recipe.cornerIndex < 0
      || recipe.cornerIndex >= STUDIO_SHEET_METAL_LIMITS.profilePoints.maximum) {
      throw new Error(path + ' corner relief corner index must be an integer inside the profile bound.');
    }
    if (!STUDIO_SHEET_METAL_RELIEF_STYLES.includes(recipe.style)) {
      throw new Error(path + ' corner-relief style must be rectangular or circular.');
    }
    if (typeof recipe.reliefSize !== 'number' || !Number.isFinite(recipe.reliefSize) || recipe.reliefSize <= 0) {
      throw new Error(path + ' corner relief requires a stored positive relief size.');
    }
    if (feature.resultPolicy?.kind !== 'subtract'
      || JSON.stringify(feature.resultPolicy.targetBodyIds) !== JSON.stringify([recipe.baseBodyId])) {
      throw new Error(path + ' corner relief must subtract from exactly its base-flange body.');
    }
    const reliefRoles = [
      ['feature', 'base-flange', recipe.baseFeatureId],
      ['body', 'relief-target', recipe.baseBodyId],
    ];
    if (!Array.isArray(feature.inputRefs) || feature.inputRefs.length !== reliefRoles.length
      || reliefRoles.some(([ownerKind, role, ownerId], index) => {
        const reference = feature.inputRefs[index];
        return !referenceRole(reference, ownerKind, role) || reference.ownerId !== ownerId;
      })) {
      throw new Error(path + ' corner-relief inputs are detached from the base flange and its body.');
    }
    return clone(recipe);
  }
  if (recipe.kind === 'flat-pattern') {
    exactKeys(recipe, [
      'schema', 'version', 'kind', 'featureId', 'baseFeatureId', 'baseBodyId', 'flangePolicy', 'complianceStatus',
    ], path + '.extensions.sheetMetal');
    if (recipe.flangePolicy !== STUDIO_SHEET_METAL_FLAT_POLICY) throw new Error(path + ' flat-pattern policy evidence is invalid.');
    assertStudioSheetMetalId(recipe.baseFeatureId);
    if (typeof recipe.baseBodyId !== 'string' || !recipe.baseBodyId) throw new Error(path + ' flat pattern requires its base body reference.');
    if (feature.resultPolicy?.kind !== 'new-body') throw new Error(path + ' flat pattern must create one derived read-only body.');
    const flatRoles = [
      ['feature', 'base-flange', recipe.baseFeatureId],
      ['body', 'flat-source', recipe.baseBodyId],
    ];
    if (!Array.isArray(feature.inputRefs) || feature.inputRefs.length !== flatRoles.length
      || flatRoles.some(([ownerKind, role, ownerId], index) => {
        const reference = feature.inputRefs[index];
        return !referenceRole(reference, ownerKind, role) || reference.ownerId !== ownerId;
      })) {
      throw new Error(path + ' flat-pattern inputs are detached from the base flange and its body.');
    }
    return clone(recipe);
  }
  exactKeys(recipe, [
    'schema', 'version', 'kind', 'featureId', 'baseFeatureId', 'baseBodyId', 'segmentIndex', 'side',
    'bendAngleDegrees', 'bendRadius', 'kFactor', 'flangeLength', 'bendAllowance',
    'edgeName', 'sheetFaceName', 'attachmentFaceName', 'flangePolicy', 'complianceStatus',
  ], path + '.extensions.sheetMetal');
  if (recipe.flangePolicy !== STUDIO_SHEET_METAL_EDGE_POLICY) throw new Error(path + ' edge-flange policy evidence is invalid.');
  if (recipe.bendAngleDegrees !== STUDIO_SHEET_METAL_BEND_ANGLE_DEGREES) {
    throw new Error(path + ' edge flange supports exactly the 90-degree bend in this slice.');
  }
  assertStudioSheetMetalId(recipe.baseFeatureId);
  if (typeof recipe.baseBodyId !== 'string' || !recipe.baseBodyId) throw new Error(path + ' edge flange requires its base body reference.');
  if (!STUDIO_SHEET_METAL_EDGE_SIDES.includes(recipe.side)) throw new Error(path + ' edge-flange side must be up or down.');
  studioSheetMetalSegmentEntityId(recipe.segmentIndex);
  literalInRange(recipe.bendRadius, STUDIO_SHEET_METAL_LIMITS.bendRadius, path + ' bend radius');
  literalInRange(recipe.kFactor, STUDIO_SHEET_METAL_LIMITS.kFactor, path + ' K-factor');
  literalInRange(recipe.flangeLength, STUDIO_SHEET_METAL_LIMITS.flangeLength, path + ' flange length');
  if (typeof recipe.bendAllowance !== 'number' || !Number.isFinite(recipe.bendAllowance) || recipe.bendAllowance <= 0) {
    throw new Error(path + ' edge flange requires a stored positive bend allowance.');
  }
  if (recipe.edgeName !== studioSheetMetalBendEdgeName(recipe.baseFeatureId, recipe.segmentIndex, recipe.side)
    || recipe.sheetFaceName !== studioSheetMetalCapFaceName(recipe.baseFeatureId, recipe.side)
    || recipe.attachmentFaceName !== studioSheetMetalSideFaceName(recipe.baseFeatureId, recipe.segmentIndex)) {
    throw new Error(path + ' edge-flange persistent topology names are detached from the selected base segment.');
  }
  if (feature.resultPolicy?.kind !== 'add'
    || JSON.stringify(feature.resultPolicy.targetBodyIds) !== JSON.stringify([recipe.baseBodyId])) {
    throw new Error(path + ' edge flange must modify exactly its base-flange body.');
  }
  const expectedRoles = [
    ['feature', 'base-flange', recipe.baseFeatureId],
    ['body', 'bend-edge', recipe.baseBodyId],
    ['body', 'sheet-face', recipe.baseBodyId],
    ['body', 'attachment-face', recipe.baseBodyId],
  ];
  if (!Array.isArray(feature.inputRefs) || feature.inputRefs.length !== expectedRoles.length
    || expectedRoles.some(([ownerKind, role, ownerId], index) => {
      const reference = feature.inputRefs[index];
      return !referenceRole(reference, ownerKind, role) || reference.ownerId !== ownerId;
    })) {
    throw new Error(path + ' edge-flange inputs are detached from the base flange and its persistent topology.');
  }
  const named = new Map([
    ['bend-edge', ['edge', recipe.edgeName]],
    ['sheet-face', ['face', recipe.sheetFaceName]],
    ['attachment-face', ['face', recipe.attachmentFaceName]],
  ]);
  for (const reference of feature.inputRefs) {
    const expectation = named.get(reference.semanticPath?.role);
    if (!expectation) continue;
    if (reference.semanticPath.topologyKind !== expectation[0] || reference.semanticPath.name !== expectation[1]) {
      throw new Error(path + ' edge-flange stored persistent-name references are tampered.');
    }
  }
  return clone(recipe);
}

function polygonOrientationSign(points, label) {
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;
  if (!(Math.abs(area) > EPSILON)) throw new Error(label + ' has zero enclosed area.');
  return { area: Math.abs(area), sign: area > 0 ? 1 : -1 };
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a, b, c, d) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON));
}

function validateSimplePolygon(points, label) {
  const limits = STUDIO_SHEET_METAL_LIMITS.profilePoints;
  if (!Array.isArray(points) || points.length < limits.minimum || points.length > limits.maximum) {
    throw new Error(label + ' must contain ' + limits.minimum + ' to ' + limits.maximum + ' polygon points.');
  }
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    if (!Array.isArray(point) || point.length !== 2 || point.some((value) => !Number.isFinite(value))) {
      throw new Error(label + ' contains a non-finite point.');
    }
    if (Math.hypot(next[0] - point[0], next[1] - point[1]) <= EPSILON) throw new Error(label + ' contains a zero-length segment.');
  }
  for (let left = 0; left < points.length; left++) {
    for (let right = left + 1; right < points.length; right++) {
      if (right === left + 1 || (left === 0 && right === points.length - 1)) continue;
      if (segmentsIntersect(points[left], points[(left + 1) % points.length], points[right], points[(right + 1) % points.length])) {
        throw new Error(label + ' self-intersects.');
      }
    }
  }
  return polygonOrientationSign(points, label);
}

function evaluatedProfilePoints(sketch, path, evaluate) {
  const entity = sketch.entities?.[0];
  if (sketch.extensions?.studioRole !== 'profile' || sketch.extensions?.referenceCurve
    || sketch.entities?.length !== 1 || entity?.kind !== 'polyline' || entity.closed !== true) {
    throw new Error(path + ' base flange requires one direct closed polyline profile sketch.');
  }
  return entity.points.map((point, pointIndex) => {
    if (!Array.isArray(point) || point.length !== 2) throw new Error(path + ' profile points must contain two coordinates.');
    return point.map((value, axis) => {
      const number = Number(evaluate(value, path + '.profile[' + pointIndex + '][' + axis + ']'));
      if (!Number.isFinite(number)) throw new Error(path + ' profile coordinate must evaluate to a finite number.');
      return number;
    });
  });
}

function sheetMetalFeaturePosition(part, feature) {
  // featureOrder is the schema-5 history authority; the features array may be
  // stored in any permutation, so array position is only a fallback for
  // documents without an order list.
  const order = Array.isArray(part.featureOrder) ? part.featureOrder.indexOf(feature?.id) : -1;
  return order >= 0 ? order : (part.features || []).indexOf(feature);
}

function sheetMetalRecipesOf(part, baseFeatureId, kind) {
  return (part.features || [])
    .filter((entry) => isStudioSheetMetalFeature(entry)
      && entry.extensions.sheetMetal.kind === kind
      && entry.extensions.sheetMetal.baseFeatureId === baseFeatureId)
    .map((entry) => ({ feature: entry, recipe: entry.extensions.sheetMetal, index: sheetMetalFeaturePosition(part, entry) }));
}

function segmentDirection(points, segmentIndex, label) {
  const from = points[segmentIndex];
  const to = points[(segmentIndex + 1) % points.length];
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (!(length > EPSILON)) throw new Error(label + ' has a degenerate profile segment.');
  return { direction: [(to[0] - from[0]) / length, (to[1] - from[1]) / length], length };
}

// The exact relief sizes consuming each end of one base profile segment: the
// relief at the segment's start corner and the relief at its end corner.
function reliefSizesForSegment(reliefs, segmentIndex, pointCount) {
  const startCorner = segmentIndex;
  const endCorner = (segmentIndex + 1) % pointCount;
  const sizeAt = (cornerIndex) => reliefs.find((entry) => entry.recipe.cornerIndex === cornerIndex)?.recipe.reliefSize || 0;
  return { start: sizeAt(startCorner), end: sizeAt(endCorner) };
}

function assertSheetMetalTableFactor(table, recipe, thickness, path, label) {
  if (!table) return;
  const expected = studioSheetMetalBendTableLookup(table, thickness, recipe.bendRadius, path + ' ' + label);
  if (recipe.kFactor !== expected) {
    throw new Error(path + ' ' + label + ' stored K-factor does not equal the exact bend-table row for thickness '
      + thickness + ' and bend radius ' + recipe.bendRadius + '.');
  }
}

// Document-level validation shared by the persisted-project boundary and the
// production worker. `evaluate` resolves stored expressions in the caller's
// parameter scope; recipe numerics themselves are always literal.
export function assertStudioSheetMetalPart(part, feature, path = 'part', evaluate = (value) => Number(value)) {
  const recipe = assertStudioSheetMetalFeature(feature, path + '.feature');
  const bendTable = studioSheetMetalBendTable(part);
  if (recipe.kind === 'base-flange') {
    const sketch = part.sketches?.find((entry) => entry.id === recipe.profileSketchId);
    if (!sketch) throw new Error(path + ' base-flange profile sketch is missing.');
    if (sketch.support?.ownerKind !== 'datum' || typeof sketch.support?.ownerId !== 'string') {
      throw new Error(path + ' base-flange profile sketch must be supported by a datum plane.');
    }
    assertSheetMetalTableFactor(bendTable, recipe, recipe.thickness, path, 'base flange');
    const points = evaluatedProfilePoints(sketch, path, evaluate);
    const polygon = validateSimplePolygon(points, path + ' base-flange profile');
    return {
      recipe,
      profilePoints: points,
      profileArea: polygon.area,
      orientationSign: polygon.sign,
      supportDatumId: sketch.support.ownerId,
    };
  }
  const kindLabel = recipe.kind === 'edge-flange' ? 'edge flange'
    : recipe.kind === 'corner-relief' ? 'corner relief' : 'flat pattern';
  const baseFeature = part.features?.find((entry) => entry.id === recipe.baseFeatureId);
  if (!isStudioSheetMetalFeature(baseFeature)) throw new Error(path + ' ' + kindLabel + ' requires an existing base flange.');
  const baseChecked = assertStudioSheetMetalPart(part, baseFeature, path + '.base', evaluate);
  if (baseChecked.recipe.kind !== 'base-flange') {
    throw new Error(path + ' ' + kindLabel + ' must reference a base flange, not another sheet-metal feature.');
  }
  const baseIndex = sheetMetalFeaturePosition(part, baseFeature);
  const featureIndex = sheetMetalFeaturePosition(part, feature);
  if (baseIndex < 0 || featureIndex < 0 || baseIndex >= featureIndex) {
    throw new Error(path + ' ' + kindLabel + ' must follow its base flange in the feature history.');
  }
  const body = part.bodies?.find((entry) => entry.createdByFeatureId === recipe.baseFeatureId);
  if (!body || body.id !== recipe.baseBodyId) throw new Error(path + ' ' + kindLabel + ' is detached from the base-flange body.');
  const points = baseChecked.profilePoints;
  const pointCount = points.length;
  const reliefs = sheetMetalRecipesOf(part, recipe.baseFeatureId, 'corner-relief');
  const flanges = sheetMetalRecipesOf(part, recipe.baseFeatureId, 'edge-flange');
  if (recipe.kind === 'edge-flange') {
    if (recipe.segmentIndex >= pointCount) {
      throw new Error(path + ' edge flange references a profile segment outside the base profile.');
    }
    const duplicate = flanges.find((entry) => entry.feature !== feature && entry.recipe.edgeName === recipe.edgeName);
    if (duplicate) {
      throw new Error(path + ' persistent edge "' + recipe.edgeName + '" already carries edge flange "' + duplicate.feature.id + '".');
    }
    assertSheetMetalTableFactor(bendTable, recipe, baseChecked.recipe.thickness, path, 'edge flange');
    const expectedAllowance = studioSheetMetalBendAllowance(
      recipe.bendRadius,
      recipe.kFactor,
      baseChecked.recipe.thickness,
      recipe.bendAngleDegrees,
    );
    if (recipe.bendAllowance !== expectedAllowance) {
      throw new Error(path + ' stored bend allowance does not equal the exact closed-form (R + K*t) * angle value.');
    }
    for (const relief of reliefs) {
      if (relief.index >= featureIndex) {
        throw new Error(path + ' edge flange must follow every corner relief of its base flange in the feature history.');
      }
    }
    // Two edge flanges meeting at a shared base corner would fuse coincident
    // cap and side faces into one unresolvable merged face. The shared corner
    // must carry a corner relief, which shortens both swept edges away from
    // the corner.
    for (const other of flanges) {
      if (other.feature === feature) continue;
      const difference = (other.recipe.segmentIndex - recipe.segmentIndex + pointCount) % pointCount;
      if (difference !== 1 && difference !== pointCount - 1) continue;
      const sharedCorner = difference === 1
        ? (recipe.segmentIndex + 1) % pointCount
        : recipe.segmentIndex;
      if (!reliefs.some((entry) => entry.recipe.cornerIndex === sharedCorner)) {
        throw new Error(path + ' edge flanges "' + feature.id + '" and "' + other.feature.id
          + '" meet at shared base corner ' + sharedCorner + ' and require a corner relief there.');
      }
    }
    const segment = segmentDirection(points, recipe.segmentIndex, path + ' edge flange');
    const sizes = reliefSizesForSegment(reliefs, recipe.segmentIndex, pointCount);
    const effectiveLength = segment.length - sizes.start - sizes.end;
    if (!(effectiveLength > EPSILON)) {
      throw new Error(path + ' corner reliefs consume the entire flanged base segment ' + recipe.segmentIndex + '.');
    }
    return {
      recipe,
      base: baseChecked,
      baseFeature,
      baseBody: clone(body),
      bendAllowance: expectedAllowance,
      segmentLength: segment.length,
      reliefStart: sizes.start,
      reliefEnd: sizes.end,
      effectiveLength,
    };
  }
  if (recipe.kind === 'corner-relief') {
    if (recipe.cornerIndex >= pointCount) {
      throw new Error(path + ' corner relief references a corner outside the base profile.');
    }
    const duplicate = reliefs.find((entry) => entry.feature !== feature && entry.recipe.cornerIndex === recipe.cornerIndex);
    if (duplicate) {
      throw new Error(path + ' base corner ' + recipe.cornerIndex + ' already carries corner relief "' + duplicate.feature.id + '".');
    }
    const expectedSize = studioSheetMetalReliefSize(baseChecked.recipe.bendRadius, baseChecked.recipe.thickness);
    if (recipe.reliefSize !== expectedSize) {
      throw new Error(path + ' stored relief size does not equal the exact closed-form bendRadius + thickness value.');
    }
    for (const flange of flanges) {
      if (flange.index <= featureIndex) {
        throw new Error(path + ' corner relief must precede every edge flange of its base flange in the feature history.');
      }
    }
    const inbound = segmentDirection(points, (recipe.cornerIndex + pointCount - 1) % pointCount, path + ' corner relief');
    const outbound = segmentDirection(points, recipe.cornerIndex, path + ' corner relief');
    if (Math.abs(inbound.direction[0] * outbound.direction[0] + inbound.direction[1] * outbound.direction[1]) > 1e-9) {
      throw new Error(path + ' corner relief requires an exactly perpendicular base corner; non-90-degree corners are excluded.');
    }
    for (const segmentIndex of [(recipe.cornerIndex + pointCount - 1) % pointCount, recipe.cornerIndex]) {
      const segment = segmentDirection(points, segmentIndex, path + ' corner relief');
      const sizes = reliefSizesForSegment(reliefs, segmentIndex, pointCount);
      if (!(segment.length - sizes.start - sizes.end > EPSILON)) {
        throw new Error(path + ' corner reliefs consume the entire base segment ' + segmentIndex + '.');
      }
    }
    return {
      recipe,
      base: baseChecked,
      baseFeature,
      baseBody: clone(body),
      corner: {
        index: recipe.cornerIndex,
        point: clone(points[recipe.cornerIndex]),
        inboundDirection: inbound.direction,
        outboundDirection: outbound.direction,
        reliefSize: expectedSize,
        reliefArea: studioSheetMetalReliefArea(recipe.style, expectedSize),
      },
    };
  }
  const duplicate = part.features.find((entry) => entry !== feature
    && isStudioSheetMetalFeature(entry)
    && entry.extensions.sheetMetal.kind === 'flat-pattern'
    && entry.extensions.sheetMetal.baseFeatureId === recipe.baseFeatureId);
  if (duplicate) {
    throw new Error(path + ' base flange "' + recipe.baseFeatureId + '" already carries flat pattern "' + duplicate.id + '".');
  }
  for (const sibling of [...flanges, ...reliefs]) {
    if (sibling.index >= featureIndex) {
      throw new Error(path + ' flat pattern must follow every edge flange and corner relief of its base flange in the feature history.');
    }
  }
  const plan = studioSheetMetalFlatPlan({
    points,
    flanges: flanges.map((entry) => ({
      featureId: entry.feature.id,
      segmentIndex: entry.recipe.segmentIndex,
      developedLength: entry.recipe.bendAllowance + entry.recipe.flangeLength,
    })),
    reliefs: reliefs.map((entry) => ({
      featureId: entry.feature.id,
      cornerIndex: entry.recipe.cornerIndex,
      style: entry.recipe.style,
      reliefSize: entry.recipe.reliefSize,
    })),
  }, path + ' flat pattern');
  return {
    recipe,
    base: baseChecked,
    baseFeature,
    baseBody: clone(body),
    plan,
  };
}

// --- flat pattern -----------------------------------------------------------
// The exact developed outline of one base flange plus its edge flanges and
// corner reliefs, walked as a single closed chain of lines and relief arcs in
// base-profile plane coordinates. Every flanged segment develops outward by
// its stored bend allowance plus flange length over the relief-shortened
// segment extent; every relieved corner opens the exact square or quarter-arc
// cutout toward the developed corner gap. The production worker extrudes this
// chain by the sheet thickness and the DXF export writes the same chain, so
// the closed-form area below is the single authority for the flat volume:
//   flatArea = profileArea
//            + sum(effectiveSegmentLength * developedLength)   per flange
//            - sum(reliefSize^2 or (pi/4) * reliefSize^2)      per relief
export function studioSheetMetalFlatPlan(input, label = 'Flat pattern') {
  const polygon = validateSimplePolygon(input?.points, label + ' base profile');
  const points = input.points.map((point) => [Number(point[0]), Number(point[1])]);
  const pointCount = points.length;
  const flangeBySegment = new Map();
  for (const flange of input?.flanges || []) {
    if (!Number.isInteger(flange?.segmentIndex) || flange.segmentIndex < 0 || flange.segmentIndex >= pointCount) {
      throw new Error(label + ' references a flanged segment outside the base profile.');
    }
    if (flangeBySegment.has(flange.segmentIndex)) throw new Error(label + ' repeats flanged segment ' + flange.segmentIndex + '.');
    const developedLength = Number(flange.developedLength);
    if (!Number.isFinite(developedLength) || developedLength <= 0) {
      throw new Error(label + ' requires a finite positive developed length per flange.');
    }
    flangeBySegment.set(flange.segmentIndex, { ...flange, developedLength });
  }
  const reliefByCorner = new Map();
  for (const relief of input?.reliefs || []) {
    if (!Number.isInteger(relief?.cornerIndex) || relief.cornerIndex < 0 || relief.cornerIndex >= pointCount) {
      throw new Error(label + ' references a relieved corner outside the base profile.');
    }
    if (reliefByCorner.has(relief.cornerIndex)) throw new Error(label + ' repeats relieved corner ' + relief.cornerIndex + '.');
    reliefByCorner.set(relief.cornerIndex, {
      ...relief,
      area: studioSheetMetalReliefArea(relief.style, relief.reliefSize),
    });
  }
  // For either polygon orientation the outward normal of a directed segment
  // and the inward corner diagonal are fixed by the enclosed-area sign.
  const outwardOf = (direction) => (polygon.sign > 0
    ? [direction[1], -direction[0]]
    : [-direction[1], direction[0]]);
  const entities = [];
  const developed = [];
  let developedArea = 0;
  let reliefArea = 0;
  const pushLine = (id, from, to) => {
    if (!(Math.hypot(to[0] - from[0], to[1] - from[1]) > EPSILON)) {
      throw new Error(label + ' produced a degenerate outline segment (' + id + ').');
    }
    entities.push({ kind: 'line', id, a2: from, b2: to });
  };
  for (let segmentIndex = 0; segmentIndex < pointCount; segmentIndex++) {
    const from = points[segmentIndex];
    const to = points[(segmentIndex + 1) % pointCount];
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const direction = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    const startSize = reliefByCorner.get(segmentIndex)?.reliefSize || 0;
    const endCorner = (segmentIndex + 1) % pointCount;
    const endSize = reliefByCorner.get(endCorner)?.reliefSize || 0;
    const effectiveLength = length - startSize - endSize;
    if (!(effectiveLength > EPSILON)) {
      throw new Error(label + ' corner reliefs consume the entire base segment ' + segmentIndex + '.');
    }
    const start = [from[0] + startSize * direction[0], from[1] + startSize * direction[1]];
    const end = [to[0] - endSize * direction[0], to[1] - endSize * direction[1]];
    const flange = flangeBySegment.get(segmentIndex);
    if (flange) {
      const outward = outwardOf(direction);
      const depth = flange.developedLength;
      const outerStart = [start[0] + depth * outward[0], start[1] + depth * outward[1]];
      const outerEnd = [end[0] + depth * outward[0], end[1] + depth * outward[1]];
      pushLine('flat:dev:' + segmentIndex + ':out', start, outerStart);
      pushLine('flat:dev:' + segmentIndex + ':tip', outerStart, outerEnd);
      pushLine('flat:dev:' + segmentIndex + ':return', outerEnd, end);
      developedArea += effectiveLength * depth;
      developed.push({
        featureId: flange.featureId,
        segmentIndex,
        developedLength: depth,
        effectiveLength,
      });
    } else {
      pushLine('flat:seg:' + segmentIndex, start, end);
    }
    const relief = reliefByCorner.get(endCorner);
    if (relief) {
      const corner = points[endCorner];
      const nextTo = points[(endCorner + 1) % pointCount];
      const nextLength = Math.hypot(nextTo[0] - corner[0], nextTo[1] - corner[1]);
      const nextDirection = [(nextTo[0] - corner[0]) / nextLength, (nextTo[1] - corner[1]) / nextLength];
      const size = relief.reliefSize;
      const mouthEnd = [corner[0] + size * nextDirection[0], corner[1] + size * nextDirection[1]];
      if (relief.style === 'rectangular') {
        const inner = [
          corner[0] + size * (nextDirection[0] - direction[0]),
          corner[1] + size * (nextDirection[1] - direction[1]),
        ];
        pushLine('flat:relief:' + endCorner + ':a', end, inner);
        pushLine('flat:relief:' + endCorner + ':b', inner, mouthEnd);
      } else {
        const diagonal = Math.SQRT1_2;
        entities.push({
          kind: 'arc',
          id: 'flat:relief:' + endCorner + ':arc',
          a2: end,
          b2: mouthEnd,
          mid2: [
            corner[0] + size * diagonal * (nextDirection[0] - direction[0]),
            corner[1] + size * diagonal * (nextDirection[1] - direction[1]),
          ],
          center2: clone(corner),
          radius: size,
        });
      }
      reliefArea += relief.area;
    }
  }
  // The prism constructor requires the chain to end with a straight segment
  // returning to its start; rotate the closed chain so a line is last.
  let lastLine = -1;
  for (let index = entities.length - 1; index >= 0; index--) {
    if (entities[index].kind === 'line') { lastLine = index; break; }
  }
  if (lastLine < 0) throw new Error(label + ' outline contains no straight segment.');
  const chain = [...entities.slice(lastLine + 1), ...entities.slice(0, lastLine + 1)];
  // Fail closed when the developed outline self-intersects (for example a
  // flange developed into a neighboring concave region). Arcs are guarded by
  // their chords; the production worker's exact volume check is the final
  // authority.
  const guard = chain.map((entity) => entity.a2);
  for (let left = 0; left < guard.length; left++) {
    for (let right = left + 1; right < guard.length; right++) {
      if (right === left + 1 || (left === 0 && right === guard.length - 1)) continue;
      if (segmentsIntersect(
        guard[left], guard[(left + 1) % guard.length],
        guard[right], guard[(right + 1) % guard.length],
      )) {
        throw new Error(label + ' developed outline self-intersects.');
      }
    }
  }
  return {
    entities: chain,
    profileArea: polygon.area,
    developedArea,
    reliefArea,
    flatArea: polygon.area + developedArea - reliefArea,
    orientationSign: polygon.sign,
    developed,
  };
}

// The same flat outline as one constraint-native sketch for the
// partmode.dxf/v1 sketch writer: fixed points at every chain junction plus
// line and arc curve entities in base-profile plane millimetres.
export function studioSheetMetalFlatSketch(plan) {
  if (!plan || !Array.isArray(plan.entities) || !plan.entities.length) {
    throw new Error('Flat-pattern sketch requires one computed flat-pattern plan.');
  }
  const entities = [];
  const pointIds = new Map();
  const pointId = (at) => {
    const key = at[0] + '|' + at[1];
    if (!pointIds.has(key)) {
      const id = 'fp' + pointIds.size;
      pointIds.set(key, id);
      entities.push({ id, kind: 'point', at: [at[0], at[1]], fixed: true });
    }
    return pointIds.get(key);
  };
  for (const entity of plan.entities) {
    if (entity.kind === 'line') {
      entities.push({ id: entity.id, kind: 'line', a: pointId(entity.a2), b: pointId(entity.b2) });
    } else {
      const ccw = orientation(entity.a2, entity.mid2, entity.b2) > 0;
      entities.push({
        id: entity.id,
        kind: 'arc',
        center: pointId(entity.center2),
        a: pointId(entity.a2),
        b: pointId(entity.b2),
        ccw,
      });
    }
  }
  return { entities, constraints: [] };
}

// Exact cross-section constants for the 90-degree edge-flange increment. The
// added material per unit edge length is one quarter annulus plus the flat
// wall: (pi/4) * ((R + t)^2 - R^2) + flangeLength * t.
export function studioSheetMetalEdgeSectionArea(bendRadius, thickness, flangeLength) {
  const radius = Number(bendRadius);
  const sheet = Number(thickness);
  const wall = Number(flangeLength);
  if (![radius, sheet, wall].every(Number.isFinite) || radius <= 0 || sheet <= 0 || wall <= 0) {
    throw new Error('Edge-flange section area requires finite positive bend radius, thickness, and flange length.');
  }
  return (Math.PI / 4) * ((radius + sheet) ** 2 - radius ** 2) + wall * sheet;
}

export function studioSheetMetalEdgePatch(previous, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Edge-flange patch must be an object.');
  for (const immutable of ['kind', 'baseFeatureId', 'baseBodyId', 'segmentIndex', 'side', 'bendAngleDegrees', 'bendAllowance', 'edgeName', 'sheetFaceName', 'attachmentFaceName']) {
    if (owns(patch, immutable)) {
      throw new Error('Edge-flange ' + immutable + ' is immutable; delete the flange and create a new one instead.');
    }
  }
  return {
    segmentIndex: previous.segmentIndex,
    side: previous.side,
    bendRadius: owns(patch, 'bendRadius') ? patch.bendRadius : previous.bendRadius,
    kFactor: owns(patch, 'kFactor') ? patch.kFactor : previous.kFactor,
    flangeLength: owns(patch, 'flangeLength') ? patch.flangeLength : previous.flangeLength,
  };
}

export function studioSheetMetalBasePatch(previous, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Base-flange patch must be an object.');
  for (const immutable of ['kind', 'profileSketchId']) {
    if (owns(patch, immutable)) {
      throw new Error('Base-flange ' + immutable + ' is immutable; delete the flange and create a new one instead.');
    }
  }
  return {
    thickness: owns(patch, 'thickness') ? patch.thickness : previous.thickness,
    kFactor: owns(patch, 'kFactor') ? patch.kFactor : previous.kFactor,
    bendRadius: owns(patch, 'bendRadius') ? patch.bendRadius : previous.bendRadius,
  };
}

// Corner reliefs and flat patterns are fully derived from their base flange;
// nothing but the display name is editable.
export function studioSheetMetalDerivedPatch(kind, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Sheet-metal patch must be an object.');
  const extra = Object.keys(patch).filter((key) => key !== 'name');
  if (extra.length) {
    throw new Error((kind === 'corner-relief' ? 'Corner relief' : 'Flat pattern')
      + ' fields are derived; only the name can be edited. Delete the feature and create a new one instead of changing "'
      + extra[0] + '".');
  }
}
