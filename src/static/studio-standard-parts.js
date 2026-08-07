// Configuration-controlled ISO metric standard-part content.
//
// The dimensional rows below are a deliberately bounded nominal subset. They
// create normal editable schema-5 documents and exact kernel solids; they are
// not manufacturing certification or a substitute for a licensed standard.

import { normalizeStudioPartConfigurationSet } from './studio-part-configurations.js';

const officialSource = (standard, edition, title, url, status) => Object.freeze({
  standard,
  edition,
  title,
  url,
  status,
  verifiedOn: '2026-08-02',
});

const SOURCES = Object.freeze({
  iso4017: officialSource(
    'ISO 4017',
    '2022',
    'Fasteners - Hexagon head screws - Product grades A and B',
    'https://www.iso.org/standard/72585.html',
    'published',
  ),
  iso4032: officialSource(
    'ISO 4032',
    '2023',
    'Fasteners - Hexagon regular nuts (style 1)',
    'https://www.iso.org/standard/75016.html',
    'published',
  ),
  iso7089: officialSource(
    'ISO 7089',
    '2000',
    'Plain washers - Normal series - Product grade A',
    'https://www.iso.org/standard/13666.html',
    'published; confirmed 2021; revision in development',
  ),
});

const METRIC_SCREW_SIZES = Object.freeze([
  Object.freeze({ thread: 'M5', d: 5, pitch: 0.8, s: 8, k: 3.5, lengths: Object.freeze([10, 16, 25]) }),
  Object.freeze({ thread: 'M6', d: 6, pitch: 1, s: 10, k: 4, lengths: Object.freeze([12, 20, 30]) }),
  Object.freeze({ thread: 'M8', d: 8, pitch: 1.25, s: 13, k: 5.3, lengths: Object.freeze([16, 25, 40]) }),
  Object.freeze({ thread: 'M10', d: 10, pitch: 1.5, s: 16, k: 6.4, lengths: Object.freeze([20, 30, 50]) }),
  Object.freeze({ thread: 'M12', d: 12, pitch: 1.75, s: 18, k: 7.5, lengths: Object.freeze([25, 40, 60]) }),
]);

const screwRows = METRIC_SCREW_SIZES.flatMap((size) => size.lengths.map((length) => Object.freeze({
  designation: `${size.thread}x${length}`,
  partNumber: `ISO4017-${size.thread}x${length}`,
  thread: size.thread,
  threadMajor: size.d,
  coarsePitch: size.pitch,
  length,
  headAcrossFlats: size.s,
  headHeight: size.k,
})));

const nutRows = Object.freeze([
  Object.freeze({ designation: 'M5', partNumber: 'ISO4032-M5', thread: 'M5', threadMajor: 5, coarsePitch: 0.8, acrossFlats: 8, height: 4.7 }),
  Object.freeze({ designation: 'M6', partNumber: 'ISO4032-M6', thread: 'M6', threadMajor: 6, coarsePitch: 1, acrossFlats: 10, height: 5.2 }),
  Object.freeze({ designation: 'M8', partNumber: 'ISO4032-M8', thread: 'M8', threadMajor: 8, coarsePitch: 1.25, acrossFlats: 13, height: 6.8 }),
  Object.freeze({ designation: 'M10', partNumber: 'ISO4032-M10', thread: 'M10', threadMajor: 10, coarsePitch: 1.5, acrossFlats: 16, height: 8.4 }),
  Object.freeze({ designation: 'M12', partNumber: 'ISO4032-M12', thread: 'M12', threadMajor: 12, coarsePitch: 1.75, acrossFlats: 18, height: 10.8 }),
]);

const washerRows = Object.freeze([
  Object.freeze({ designation: '5', partNumber: 'ISO7089-5', forThread: 'M5', bore: 5.3, outside: 10, thickness: 1 }),
  Object.freeze({ designation: '6', partNumber: 'ISO7089-6', forThread: 'M6', bore: 6.4, outside: 12, thickness: 1.6 }),
  Object.freeze({ designation: '8', partNumber: 'ISO7089-8', forThread: 'M8', bore: 8.4, outside: 16, thickness: 1.6 }),
  Object.freeze({ designation: '10', partNumber: 'ISO7089-10', forThread: 'M10', bore: 10.5, outside: 20, thickness: 2 }),
  Object.freeze({ designation: '12', partNumber: 'ISO7089-12', forThread: 'M12', bore: 13, outside: 24, thickness: 2.5 }),
]);

const configurationIdForRow = (family, row) =>
  `${family.id}-${row.designation.toLowerCase().replaceAll('x', '-')}`;

const clone = (value) => structuredClone(value);

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const reference = (ownerKind, ownerId, role) => ({
  ownerKind,
  ownerId,
  semanticPath: { role },
  signature: { role },
});

const circle = (id, r, z = 0) => ({
  id: `sketch-${id}`,
  name: id,
  entities: [],
  groups: [],
  shapes: [{ id: `shape-${id}`, kind: 'circle', x: 0, y: 0, r }],
  z,
});

const hexagon = (id, acrossFlats, z = 0) => ({
  id: `sketch-${id}`,
  name: id,
  entities: [],
  groups: [],
  shapes: [{
    id: `shape-${id}`,
    kind: 'poly',
    pts: [
      [`${acrossFlats}/sqrt(3)`, 0],
      [`${acrossFlats}/(2*sqrt(3))`, `${acrossFlats}/2`],
      [`-${acrossFlats}/(2*sqrt(3))`, `${acrossFlats}/2`],
      [`-${acrossFlats}/sqrt(3)`, 0],
      [`-${acrossFlats}/(2*sqrt(3))`, `-${acrossFlats}/2`],
      [`${acrossFlats}/(2*sqrt(3))`, `-${acrossFlats}/2`],
    ],
    edgeIds: Array.from({ length: 6 }, (_value, index) => `edge-${id}-${index + 1}`),
  }],
  z,
});

const parameter = (familyId, name, value) => ({
  id: `parameter-${familyId}-${name.replaceAll('_', '-')}`,
  name,
  value,
});

function catalogExtensions(family, configurationData) {
  return {
    standardPartCatalog: {
      schema: 'partmode.standard-part-catalog/v1',
      familyId: family.id,
      source: family.source,
      configurationData,
      dimensionalPolicy: 'bounded-nominal-subset',
      modelPolicy: family.modelPolicy,
      complianceStatus: 'reference-content-not-certified',
      limitations: family.limitations,
    },
  };
}

function projectForFamily(family, parameters, features, bodyName) {
  const partId = `part-standard-${family.id}`;
  const bodyId = `body-standard-${family.id}`;
  const initial = family.rows[0];
  const initialOverrides = family.parameterOverrides(initial);
  const configurations = family.rows.map((row) => ({
    id: configurationIdForRow(family, row),
    name: `${family.source.standard}:${family.source.edition} ${row.designation}`,
    parameterOverrides: family.parameterOverrides(row),
    featureSuppressionOverrides: {},
  }));
  const configurationData = Object.fromEntries(family.rows.map((row, index) => [
    configurations[index].id,
    {
      standard: family.source.standard,
      edition: family.source.edition,
      familyId: family.id,
      designation: row.designation,
      partNumber: row.partNumber,
      threadCallout: row.thread ? `${row.thread} x ${row.coarsePitch}` : row.forThread,
      dimensions: family.parameterOverrides(row),
    },
  ]));
  const featureRecords = features(bodyId);
  return {
    schemaVersion: 5,
    projectId: `project-standard-${family.id}`,
    name: family.name,
    units: 'mm',
    parameters: [],
    materials: [],
    partDefinitions: [{
      id: partId,
      name: family.name,
      parameters: parameters.map((name) => parameter(family.id, name, initialOverrides[name])),
      referenceGeometry: [],
      sketches: [],
      bodies: [{
        id: bodyId,
        name: bodyName,
        kind: 'solid',
        createdByFeatureId: featureRecords[0].id,
        featureIds: featureRecords.map((feature) => feature.id),
        visible: true,
        suppressed: false,
      }],
      bodyPatterns: [],
      features: featureRecords,
      featureOrder: featureRecords.map((feature) => feature.id),
      metadata: {
        activeBodyId: bodyId,
        standardPart: true,
        partNumber: initial.partNumber,
        description: family.description,
      },
      extensions: catalogExtensions(family, configurationData),
    }],
    assemblyDefinitions: [],
    rootDocument: { kind: 'part', partId },
    resources: [],
    metadata: {
      standardPart: true,
      standardPartFamilyId: family.id,
      modelPolicy: family.modelPolicy,
    },
    partConfigurationSets: [{
      partId,
      activeConfigurationId: configurations[0].id,
      configurations,
    }],
  };
}

const screwFeatures = (bodyId) => [{
  id: 'feature-standard-screw-shank',
  name: 'Nominal threaded shank envelope',
  type: 'extrude',
  sketch: circle('standard-screw-shank', 'thread_major/2'),
  plane: { kind: 'base', plane: 'XY' },
  h: 'length',
  through: false,
  resultPolicy: { kind: 'new-body', bodyName: 'ISO 4017 screw' },
  createdBodyId: bodyId,
  suppressed: false,
  inputRefs: [],
}, {
  id: 'feature-standard-screw-head',
  name: 'Hexagon head',
  type: 'extrude',
  sketch: hexagon('standard-screw-head', 'head_across_flats', 'length'),
  plane: { kind: 'base', plane: 'XY' },
  h: 'head_height',
  through: false,
  resultPolicy: { kind: 'add', targetBodyIds: [bodyId] },
  suppressed: false,
  inputRefs: [reference('body', bodyId, 'target')],
}];

const nutFeatures = (bodyId) => [{
  id: 'feature-standard-nut-body',
  name: 'Hexagon nut envelope',
  type: 'extrude',
  sketch: hexagon('standard-nut-body', 'across_flats'),
  plane: { kind: 'base', plane: 'XY' },
  h: 'height',
  through: false,
  resultPolicy: { kind: 'new-body', bodyName: 'ISO 4032 nut' },
  createdBodyId: bodyId,
  suppressed: false,
  inputRefs: [],
}, {
  id: 'feature-standard-nut-thread',
  name: 'Cosmetic threaded bore envelope',
  type: 'cut',
  sketch: circle('standard-nut-thread', 'thread_major/2'),
  plane: { kind: 'base', plane: 'XY' },
  h: 'height',
  through: true,
  resultPolicy: { kind: 'subtract', targetBodyIds: [bodyId] },
  suppressed: false,
  inputRefs: [reference('body', bodyId, 'target')],
}];

const washerFeatures = (bodyId) => [{
  id: 'feature-standard-washer-body',
  name: 'Washer outside envelope',
  type: 'extrude',
  sketch: circle('standard-washer-body', 'outside_diameter/2'),
  plane: { kind: 'base', plane: 'XY' },
  h: 'thickness',
  through: false,
  resultPolicy: { kind: 'new-body', bodyName: 'ISO 7089 washer' },
  createdBodyId: bodyId,
  suppressed: false,
  inputRefs: [],
}, {
  id: 'feature-standard-washer-bore',
  name: 'Washer clearance bore',
  type: 'cut',
  sketch: circle('standard-washer-bore', 'bore_diameter/2'),
  plane: { kind: 'base', plane: 'XY' },
  h: 'thickness',
  through: true,
  resultPolicy: { kind: 'subtract', targetBodyIds: [bodyId] },
  suppressed: false,
  inputRefs: [reference('body', bodyId, 'target')],
}];

export const STANDARD_PART_FAMILIES = Object.freeze([
  Object.freeze({
    id: 'iso4017-hex-screw',
    name: 'ISO 4017 hexagon head screw',
    description: 'Configuration-controlled metric coarse-thread screw family with a nominal smooth thread envelope.',
    source: SOURCES.iso4017,
    rows: Object.freeze(screwRows),
    modelPolicy: 'nominal-envelope-cosmetic-thread',
    limitations: Object.freeze([
      'The thread is a smooth major-diameter envelope with a retained metric coarse-pitch callout.',
      'Chamfers, under-head radii, tolerances, material, coating, and property class are not selected by this starter family.',
      'Verify the designation and dimensional requirements against a licensed standard before manufacturing.',
    ]),
    parameters: Object.freeze(['thread_major', 'coarse_pitch', 'length', 'head_across_flats', 'head_height']),
    parameterOverrides: (row) => ({
      thread_major: row.threadMajor,
      coarse_pitch: row.coarsePitch,
      length: row.length,
      head_across_flats: row.headAcrossFlats,
      head_height: row.headHeight,
    }),
    features: screwFeatures,
    bodyName: 'ISO 4017 screw',
  }),
  Object.freeze({
    id: 'iso4032-hex-nut',
    name: 'ISO 4032 hexagon regular nut',
    description: 'Configuration-controlled style-1 metric nut family with a nominal smooth threaded-bore envelope.',
    source: SOURCES.iso4032,
    rows: nutRows,
    modelPolicy: 'nominal-envelope-cosmetic-thread',
    limitations: Object.freeze([
      'The internal thread is a smooth major-diameter bore with a retained metric coarse-pitch callout.',
      'Chamfers, bearing-face details, tolerances, material, coating, and property class are not selected by this starter family.',
      'Verify the designation and dimensional requirements against a licensed standard before manufacturing.',
    ]),
    parameters: Object.freeze(['thread_major', 'coarse_pitch', 'across_flats', 'height']),
    parameterOverrides: (row) => ({
      thread_major: row.threadMajor,
      coarse_pitch: row.coarsePitch,
      across_flats: row.acrossFlats,
      height: row.height,
    }),
    features: nutFeatures,
    bodyName: 'ISO 4032 nut',
  }),
  Object.freeze({
    id: 'iso7089-plain-washer',
    name: 'ISO 7089 plain washer',
    description: 'Configuration-controlled normal-series metric washer family using exact outside, bore, and thickness values.',
    source: SOURCES.iso7089,
    rows: washerRows,
    modelPolicy: 'nominal-envelope',
    limitations: Object.freeze([
      'Edge rounding, tolerances, material, coating, and hardness are not selected by this starter family.',
      'Verify the designation and dimensional requirements against a licensed standard before manufacturing.',
    ]),
    parameters: Object.freeze(['bore_diameter', 'outside_diameter', 'thickness']),
    parameterOverrides: (row) => ({
      bore_diameter: row.bore,
      outside_diameter: row.outside,
      thickness: row.thickness,
    }),
    features: washerFeatures,
    bodyName: 'ISO 7089 washer',
  }),
]);

export function getStandardPartFamily(id) {
  return STANDARD_PART_FAMILIES.find((family) => family.id === id) || null;
}

export function getStandardPartCatalogSelection(familyId, designation) {
  const family = getStandardPartFamily(familyId);
  if (!family) throw new Error(`Unknown standard-part family "${String(familyId)}".`);
  if (typeof designation !== 'string' || !designation) {
    throw new Error('A standard-part designation is required.');
  }
  const matches = family.rows.filter((row) => row.designation === designation);
  if (matches.length !== 1) {
    throw new Error(`${family.source.standard} does not contain the exact designation "${designation}".`);
  }
  const row = matches[0];
  return Object.freeze({
    familyId: family.id,
    partId: `part-standard-${family.id}`,
    bodyId: `body-standard-${family.id}`,
    configurationId: configurationIdForRow(family, row),
    designation: row.designation,
    partNumber: row.partNumber,
    parameterOverrides: Object.freeze(family.parameterOverrides(row)),
  });
}

export function selectStandardFastenerCatalogStack(thread, exactGrip) {
  if (!['M5', 'M6', 'M8', 'M10', 'M12'].includes(thread)) {
    throw new Error('Smart Fasteners supports clearance Hole Wizard designations M5, M6, M8, M10, and M12.');
  }
  if (!Number.isFinite(exactGrip) || exactGrip <= 0) {
    throw new Error('Smart Fastener exact grip must be a positive finite millimetre value.');
  }
  const nutFamily = getStandardPartFamily('iso4032-hex-nut');
  const washerFamily = getStandardPartFamily('iso7089-plain-washer');
  const nutRow = nutFamily.rows.find((row) => row.thread === thread);
  const washerRow = washerFamily.rows.find((row) => row.forThread === thread);
  const requiredLength = exactGrip + washerRow.thickness + nutRow.height + 2 * nutRow.coarsePitch;
  const screwFamily = getStandardPartFamily('iso4017-hex-screw');
  const screwRow = screwFamily.rows
    .filter((row) => row.thread === thread && row.length >= requiredLength)
    .sort((left, right) => left.length - right.length)[0];
  if (!screwRow) {
    throw new Error(`No bounded ISO 4017 ${thread} screw is long enough for the ${requiredLength} mm required stack length.`);
  }
  return Object.freeze({
    requiredLength,
    screw: getStandardPartCatalogSelection(screwFamily.id, screwRow.designation),
    washer: getStandardPartCatalogSelection(washerFamily.id, washerRow.designation),
    nut: getStandardPartCatalogSelection(nutFamily.id, nutRow.designation),
  });
}

export function canonicalStandardPartFamilyRecords(familyId) {
  const canonical = createStandardPartProject(familyId);
  return {
    partDefinition: clone(canonical.partDefinitions[0]),
    configurationSet: normalizeStudioPartConfigurationSet(canonical, canonical.partConfigurationSets[0]),
  };
}

export function assertCanonicalStandardPartFamily(project, familyId) {
  const { partDefinition, configurationSet } = canonicalStandardPartFamilyRecords(familyId);
  const partMatches = (project.partDefinitions || []).filter((entry) => entry.id === partDefinition.id);
  const setMatches = (project.partConfigurationSets || []).filter((entry) => entry.partId === partDefinition.id);
  if (partMatches.length !== 1 || setMatches.length !== 1) {
    throw new Error(`Smart Fastener catalog family "${familyId}" requires exactly one canonical part definition and configuration set.`);
  }
  if (!sameJson(partMatches[0], partDefinition)) {
    throw new Error(`Smart Fastener catalog part definition "${partDefinition.id}" is not the canonical source-owned definition.`);
  }
  if (!sameJson(setMatches[0], configurationSet)) {
    throw new Error(`Smart Fastener catalog configuration set for "${partDefinition.id}" is not canonical.`);
  }
  return { partDefinition: partMatches[0], configurationSet: setMatches[0] };
}

export function importCanonicalStandardPartFamily(project, familyId) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    throw new Error('A schema-5 project is required to import standard-part content.');
  }
  project.partDefinitions ||= [];
  project.partConfigurationSets ||= [];
  const { partDefinition, configurationSet } = canonicalStandardPartFamilyRecords(familyId);
  const partMatches = project.partDefinitions.filter((entry) => entry.id === partDefinition.id);
  const setMatches = project.partConfigurationSets.filter((entry) => entry.partId === partDefinition.id);
  if (partMatches.length || setMatches.length) {
    return assertCanonicalStandardPartFamily(project, familyId);
  }
  project.partDefinitions.push(partDefinition);
  project.partConfigurationSets.push(configurationSet);
  return { partDefinition, configurationSet };
}

export function createStandardPartProject(id, options = {}) {
  const family = getStandardPartFamily(id);
  if (!family) throw new Error(`Unknown standard-part family "${String(id)}".`);
  const project = projectForFamily(family, family.parameters, family.features, family.bodyName);
  if (options.projectId) project.projectId = options.projectId;
  if (options.name) project.name = options.name;
  return project;
}
