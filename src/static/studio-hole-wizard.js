// Standards-aware Hole Wizard for a deliberately bounded ISO metric subset.
//
// The rows are nominal reference content for interactive design and exact
// geometry. They are not manufacturing certification or a substitute for a
// licensed standard. Every persisted recipe keeps that limitation and its
// official source metadata attached to the feature.

export const STUDIO_HOLE_WIZARD_SCHEMA = 'partmode.hole-wizard/v1';

const officialSource = (id, standard, edition, title, url, status) => Object.freeze({
  id,
  standard,
  edition,
  title,
  url,
  status,
  verifiedOn: '2026-08-02',
});

export const STUDIO_HOLE_WIZARD_SOURCES = Object.freeze({
  clearance: officialSource(
    'iso273',
    'ISO 273',
    '1979',
    'Fasteners - Clearance holes for bolts and screws',
    'https://www.iso.org/standard/4183.html',
    'published; confirmed 2024',
  ),
  thread: officialSource(
    'iso261',
    'ISO 261',
    '1998',
    'ISO general purpose metric screw threads - General plan',
    'https://www.iso.org/standard/4165.html',
    'published; confirmed 2024',
  ),
  counterbore: officialSource(
    'iso4762',
    'ISO 4762',
    '2004',
    'Hexagon socket head cap screws',
    'https://www.iso.org/standard/34460.html',
    'published',
  ),
  countersink: officialSource(
    'iso10642',
    'ISO 10642',
    '2026',
    'Fasteners - Hexagon socket countersunk head screws with reduced loadability',
    'https://www.iso.org/standard/90795.html',
    'published 2026-03',
  ),
});

const row = (designation, threadMajor, coarsePitch, clearanceMedium, tapDrill, counterboreDiameter, counterboreDepth, countersinkDiameter) => Object.freeze({
  designation,
  threadMajor,
  coarsePitch,
  clearanceMedium,
  tapDrill,
  counterboreDiameter,
  counterboreDepth,
  countersinkDiameter,
});

// Medium-series clearance diameters, coarse metric pitch, common tap drills,
// and nominal socket-head envelopes. The bounded subset is intentionally
// small enough to audit as exact persisted content.
export const STUDIO_HOLE_WIZARD_ROWS = Object.freeze([
  row('M3', 3, 0.5, 3.4, 2.5, 5.5, 3, 6),
  row('M4', 4, 0.7, 4.5, 3.3, 7, 4, 8),
  row('M5', 5, 0.8, 5.5, 4.2, 8.5, 5, 10),
  row('M6', 6, 1, 6.6, 5, 10, 6, 12),
  row('M8', 8, 1.25, 9, 6.8, 13, 8, 16),
  row('M10', 10, 1.5, 11, 8.5, 16, 10, 20),
  row('M12', 12, 1.75, 13.5, 10.2, 18, 12, 24),
]);

export const STUDIO_HOLE_WIZARD_KINDS = Object.freeze([
  'clearance',
  'tapped',
  'counterbore',
  'countersink',
]);

const LIMITATIONS = Object.freeze([
  'This is bounded nominal reference content, not manufacturing certification.',
  'Verify dimensions, fits, tolerances, material, coating, and process requirements against licensed standards.',
  'Tapped holes retain an exact tap-drill bore and cosmetic metric thread callout; modeled helical threads are not generated.',
]);

const clone = (value) => structuredClone(value);
const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const same = (left, right) => Math.abs(left - right) <= 1e-12;

export class StudioHoleWizardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StudioHoleWizardError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new StudioHoleWizardError(code, message);
};

export function getStudioHoleWizardRow(designation) {
  if (typeof designation !== 'string') return null;
  return STUDIO_HOLE_WIZARD_ROWS.find((entry) => entry.designation === designation) || null;
}

function sourceIdsForKind(kind) {
  if (kind === 'clearance') return ['iso273'];
  if (kind === 'tapped') return ['iso261'];
  if (kind === 'counterbore') return ['iso273', 'iso4762'];
  if (kind === 'countersink') return ['iso273', 'iso10642'];
  fail('HOLE_WIZARD_KIND_UNSUPPORTED', `Unsupported Hole Wizard kind "${String(kind)}".`);
}

function sourcesForIds(sourceIds) {
  const sources = Object.values(STUDIO_HOLE_WIZARD_SOURCES);
  return sourceIds.map((id) => {
    const source = sources.find((entry) => entry.id === id);
    if (!source) fail('HOLE_WIZARD_SOURCE_INVALID', `Unknown Hole Wizard source "${id}".`);
    return clone(source);
  });
}

function dimensionsFor(kind, selected) {
  if (kind === 'clearance') return {
    pilotDiameter: selected.clearanceMedium,
  };
  if (kind === 'tapped') return {
    pilotDiameter: selected.tapDrill,
    tapDrillDiameter: selected.tapDrill,
    threadMajorDiameter: selected.threadMajor,
    coarsePitch: selected.coarsePitch,
  };
  if (kind === 'counterbore') return {
    pilotDiameter: selected.clearanceMedium,
    recessDiameter: selected.counterboreDiameter,
    recessDepth: selected.counterboreDepth,
  };
  if (kind === 'countersink') {
    const recessDepth = (selected.countersinkDiameter - selected.clearanceMedium) / 2;
    return {
      pilotDiameter: selected.clearanceMedium,
      recessDiameter: selected.countersinkDiameter,
      recessDepth,
      includedAngleDegrees: 90,
    };
  }
  fail('HOLE_WIZARD_KIND_UNSUPPORTED', `Unsupported Hole Wizard kind "${String(kind)}".`);
}

export function studioHoleWizardDefinition(kind, designation) {
  if (!STUDIO_HOLE_WIZARD_KINDS.includes(kind)) {
    fail('HOLE_WIZARD_KIND_UNSUPPORTED', `Unsupported Hole Wizard kind "${String(kind)}".`);
  }
  const selected = getStudioHoleWizardRow(designation);
  if (!selected) fail('HOLE_WIZARD_SIZE_UNSUPPORTED', `Unsupported Hole Wizard size "${String(designation)}".`);
  const sourceIds = sourceIdsForKind(kind);
  return {
    kind,
    designation,
    sourceIds,
    sources: sourcesForIds(sourceIds),
    dimensions: dimensionsFor(kind, selected),
  };
}

export function createStudioHoleWizardExtension({ kind, designation, center = [0, 0] }) {
  const definition = studioHoleWizardDefinition(kind, designation);
  if (!Array.isArray(center) || center.length !== 2 || !center.every(finite)) {
    fail('HOLE_WIZARD_CENTER_INVALID', 'Hole Wizard center must contain two finite millimetre coordinates.');
  }
  return {
    schema: STUDIO_HOLE_WIZARD_SCHEMA,
    kind: definition.kind,
    designation: definition.designation,
    center: [...center],
    sourceIds: [...definition.sourceIds],
    sources: clone(definition.sources),
    dimensions: { ...definition.dimensions },
    dimensionalPolicy: 'bounded-nominal-subset',
    modelPolicy: definition.kind === 'tapped' ? 'exact-tap-drill-cosmetic-thread' : 'exact-machined-envelope',
    complianceStatus: 'reference-content-not-certified',
    limitations: [...LIMITATIONS],
  };
}

function assertExactRecord(actual, expected, path) {
  if (!isRecord(actual)) fail('HOLE_WIZARD_RECIPE_INVALID', path + ' must be an object.');
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail('HOLE_WIZARD_RECIPE_INVALID', path + ' contains unsupported or missing fields.');
  }
  for (const key of expectedKeys) {
    if (!finite(actual[key]) || !same(actual[key], expected[key])) {
      fail('HOLE_WIZARD_RECIPE_INVALID', `${path}.${key} does not match the selected nominal row.`);
    }
  }
}

export function assertStudioHoleWizardExtension(extension, path = 'feature.extensions.holeWizard') {
  if (!isRecord(extension)) fail('HOLE_WIZARD_RECIPE_INVALID', path + ' must be an object.');
  if (extension.schema !== STUDIO_HOLE_WIZARD_SCHEMA) fail('HOLE_WIZARD_RECIPE_INVALID', path + '.schema is unsupported.');
  const definition = studioHoleWizardDefinition(extension.kind, extension.designation);
  if (!Array.isArray(extension.center) || extension.center.length !== 2 || !extension.center.every(finite)) {
    fail('HOLE_WIZARD_CENTER_INVALID', path + '.center must contain two finite coordinates.');
  }
  if (JSON.stringify(extension.sourceIds) !== JSON.stringify(definition.sourceIds)) {
    fail('HOLE_WIZARD_RECIPE_INVALID', path + '.sourceIds do not match the selected hole kind.');
  }
  if (JSON.stringify(extension.sources) !== JSON.stringify(definition.sources)) {
    fail('HOLE_WIZARD_RECIPE_INVALID', path + '.sources do not match the official source metadata.');
  }
  assertExactRecord(extension.dimensions, definition.dimensions, path + '.dimensions');
  if (extension.dimensionalPolicy !== 'bounded-nominal-subset') fail('HOLE_WIZARD_RECIPE_INVALID', path + '.dimensionalPolicy is unsupported.');
  const modelPolicy = definition.kind === 'tapped' ? 'exact-tap-drill-cosmetic-thread' : 'exact-machined-envelope';
  if (extension.modelPolicy !== modelPolicy) fail('HOLE_WIZARD_RECIPE_INVALID', path + '.modelPolicy is unsupported.');
  if (extension.complianceStatus !== 'reference-content-not-certified') fail('HOLE_WIZARD_RECIPE_INVALID', path + '.complianceStatus is required.');
  if (JSON.stringify(extension.limitations) !== JSON.stringify(LIMITATIONS)) {
    fail('HOLE_WIZARD_RECIPE_INVALID', path + '.limitations must preserve the source-owned safety boundary.');
  }
  return clone({ ...definition, center: extension.center });
}

export function assertStudioHoleWizardFeature(feature, path = 'feature') {
  const extension = feature?.extensions?.holeWizard;
  const definition = assertStudioHoleWizardExtension(extension, path + '.extensions.holeWizard');
  if (feature.type !== 'cut' || feature.through !== true) {
    fail('HOLE_WIZARD_FEATURE_INVALID', path + ' must remain a Through All Cut.');
  }
  if (feature.onFace !== undefined) {
    fail('HOLE_WIZARD_FEATURE_INVALID', path + ' currently supports an exterior XY support plane, not a picked face.');
  }
  if (feature.plane !== undefined && (feature.plane?.kind !== 'base' || feature.plane?.plane !== 'XY')) {
    fail('HOLE_WIZARD_FEATURE_INVALID', path + '.plane must remain the XY base plane.');
  }
  if (feature.pattern !== undefined) fail('HOLE_WIZARD_FEATURE_INVALID', path + ' does not support feature patterns.');
  const shapes = feature.sketch?.shapes;
  if (!Array.isArray(shapes) || shapes.length !== 1 || shapes[0]?.kind !== 'circle') {
    fail('HOLE_WIZARD_FEATURE_INVALID', path + '.sketch must contain exactly one circular pilot profile.');
  }
  const shape = shapes[0];
  if (![shape.x, shape.y, shape.r].every(finite)) {
    fail('HOLE_WIZARD_FEATURE_INVALID', path + '.sketch circle must use finite literal millimetre values.');
  }
  if (!same(shape.x, definition.center[0]) || !same(shape.y, definition.center[1])) {
    fail('HOLE_WIZARD_FEATURE_INVALID', path + '.sketch circle center does not match the wizard recipe.');
  }
  if (!same(shape.r * 2, definition.dimensions.pilotDiameter)) {
    fail('HOLE_WIZARD_FEATURE_INVALID', path + '.sketch circle diameter does not match the wizard recipe.');
  }
  return definition;
}

export function createStudioHoleWizardFeature({
  id,
  bodyId,
  kind,
  designation,
  center = [0, 0],
  sketchZ = 0,
  name,
}) {
  if (typeof id !== 'string' || !id.trim()) fail('HOLE_WIZARD_ID_INVALID', 'Hole Wizard feature ID is required.');
  if (typeof bodyId !== 'string' || !bodyId.trim()) fail('HOLE_WIZARD_TARGET_INVALID', 'Hole Wizard target body ID is required.');
  if (!finite(sketchZ)) fail('HOLE_WIZARD_PLANE_INVALID', 'Hole Wizard plane offset must be a finite millimetre value.');
  const extension = createStudioHoleWizardExtension({ kind, designation, center });
  const diameter = extension.dimensions.pilotDiameter;
  const label = kind === 'tapped' ? 'Tapped hole' : kind[0].toUpperCase() + kind.slice(1) + ' hole';
  const feature = {
    id,
    name: name || `${label} ${designation}`,
    type: 'cut',
    sketch: {
      name: `${label} pilot profile`,
      shapes: [{ id: `${id}-pilot`, kind: 'circle', x: center[0], y: center[1], r: diameter / 2 }],
      z: sketchZ,
    },
    plane: { kind: 'base', plane: 'XY' },
    h: 1,
    through: true,
    resultPolicy: { kind: 'subtract', targetBodyIds: [bodyId], keepTools: false },
    suppressed: false,
    inputRefs: [{ ownerKind: 'body', ownerId: bodyId, semanticPath: { role: 'target' }, signature: { role: 'target' } }],
    extensions: { holeWizard: extension },
  };
  assertStudioHoleWizardFeature(feature);
  return feature;
}

export function studioHoleWizardOperationInput(feature) {
  assertStudioHoleWizardFeature(feature);
  return {
    id: feature.id,
    name: feature.name,
    sketch: clone(feature.sketch),
    height: feature.h,
    through: true,
    resultPolicy: clone(feature.resultPolicy),
    inputRefs: clone(feature.inputRefs),
    extensions: clone(feature.extensions),
  };
}

export function studioHoleWizardCallout(extension) {
  const definition = assertStudioHoleWizardExtension(extension);
  const dimensions = definition.dimensions;
  if (definition.kind === 'tapped') return `${definition.designation} x ${dimensions.coarsePitch} TAP, drill ${dimensions.tapDrillDiameter} mm`;
  if (definition.kind === 'counterbore') return `CBORE ${dimensions.recessDiameter} x ${dimensions.recessDepth} mm, THRU ${dimensions.pilotDiameter} mm`;
  if (definition.kind === 'countersink') return `CSK ${dimensions.recessDiameter} x ${dimensions.includedAngleDegrees} deg, THRU ${dimensions.pilotDiameter} mm`;
  return `THRU ${dimensions.pilotDiameter} mm FOR ${definition.designation}`;
}

export function studioHoleWizardSourcesFor(extension) {
  const definition = assertStudioHoleWizardExtension(extension);
  return clone(definition.sources);
}
