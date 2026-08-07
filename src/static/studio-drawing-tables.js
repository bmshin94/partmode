import { canonicalStudioV5Project, studioV5CanonicalHash, studioV5Sha256Hex } from './studio-v5-runtime-document.js';
import { evaluateStudioV5Expression, studioV5ParameterValues } from './studio-v5-modeling.js';
import { applyStudioPartConfiguration } from './studio-part-configurations.js';
import { assertStudioHoleWizardFeature, studioHoleWizardCallout } from './studio-hole-wizard.js';
import { assertStudioStructuralMemberPart } from './studio-structural-members.js';
import { assertStudioWeldmentTreatmentPart } from './studio-structural-treatments.js';
import { assertStudioWeldBeadFeature, assertStudioWeldBeadPart } from './studio-weld-beads.js';

export const STUDIO_DRAWING_TABLES_SCHEMA = 'partmode.drawing-tables/v1';
export const STUDIO_DRAWING_TABLE_KINDS = Object.freeze(['cut-list', 'hole', 'revision', 'weld']);

const clone = (value) => structuredClone(value);
const NAME = /^[^\u0000-\u001f]{1,120}$/u;
const owns = (record, key) => Object.prototype.hasOwnProperty.call(record || {}, key);

export class StudioDrawingTablesError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioDrawingTablesError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioDrawingTablesError(code, message, details);
}

function text(value, label, maximum = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || !NAME.test(value.trim())) {
    fail('DRAWING_TABLE_INPUT_INVALID', `${label} must be non-empty bounded text.`);
  }
  return value.trim();
}

function finite(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    fail('DRAWING_TABLE_INPUT_INVALID', `${label} must be between ${minimum} and ${maximum}.`);
  }
  return Math.round(number * 1000) / 1000;
}

function position(value) {
  if (!Array.isArray(value) || value.length !== 2) fail('DRAWING_TABLE_INPUT_INVALID', 'Drawing-table position must contain X and Y millimetres.');
  return [finite(value[0], 'Drawing-table X position', 0, 2_000), finite(value[1], 'Drawing-table Y position', 0, 2_000)];
}

function uniqueIds(value, label, maximum) {
  if (!Array.isArray(value) || !value.length || value.length > maximum) {
    fail('DRAWING_TABLE_INPUT_INVALID', `${label} requires 1 to ${maximum} persistent references.`);
  }
  const result = value.map((entry) => text(entry, label + ' reference', 200));
  if (new Set(result).size !== result.length) fail('DRAWING_TABLE_INPUT_INVALID', `${label} references must be unique.`);
  return result;
}

function revisionEntries(value) {
  if (!Array.isArray(value) || !value.length || value.length > 100) fail('DRAWING_TABLE_INPUT_INVALID', 'Revision table requires 1 to 100 entries.');
  const revisions = new Set();
  return value.map((entry) => {
    const revision = text(entry?.revision, 'Revision identifier', 20);
    if (revisions.has(revision.toLowerCase())) fail('DRAWING_TABLE_INPUT_INVALID', 'Revision identifiers must be unique.');
    revisions.add(revision.toLowerCase());
    const date = text(entry?.date, 'Revision date', 20);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
    const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!parsed || parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() !== Number(match[2]) - 1
      || parsed.getUTCDate() !== Number(match[3])) {
      fail('DRAWING_TABLE_INPUT_INVALID', 'Revision date must be a real YYYY-MM-DD date.');
    }
    return {
      revision,
      description: text(entry?.description, 'Revision description', 200),
      date,
      approvedBy: text(entry?.approvedBy, 'Revision approver', 80),
    };
  });
}

function drawingBook(project) {
  const book = project?.extensions?.drawingBook;
  if (!book || book.schema !== 'partmode.drawing-book/v1' || !Array.isArray(book.sheets)) {
    fail('DRAWING_BOOK_NOT_INITIALIZED', 'A drawing book is required to author drawing tables.');
  }
  return book;
}

function projectReferences(project) {
  const bodies = new Set();
  const holeFeatures = new Set();
  const weldFeatures = new Set();
  const structuralMembers = new Set();
  const rootPartId = project?.rootDocument?.kind === 'part' ? project.rootDocument.partId : null;
  for (const part of project?.partDefinitions || []) {
    for (const body of part.bodies || []) bodies.add(body.id);
    for (const feature of part.features || []) {
      if (feature.extensions?.holeWizard && feature.suppressed !== true) holeFeatures.add(feature.id);
      if (feature.type === 'weld-bead' && feature.extensions?.weldBead && feature.suppressed !== true) weldFeatures.add(feature.id);
      if (part.id === rootPartId && feature.type === 'sweep' && feature.extensions?.structuralMember
        && feature.suppressed !== true) structuralMembers.add(feature.id);
    }
  }
  return { bodies, holeFeatures, weldFeatures, structuralMembers };
}

function structuralCutListShape(source) {
  const allowed = new Set([
    'id', 'kind', 'sheetId', 'name', 'positionMm', 'widthMm', 'sourceType', 'sourceMemberIds',
  ]);
  const unsupported = Object.keys(source || {}).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    fail(
      'DRAWING_TABLE_INPUT_INVALID',
      'Structural-member cut lists cannot persist axes, body references, derived values, or unsupported fields.',
      { fields: unsupported },
    );
  }
}

function tableRecord(source, project, id, { validateReferences = true } = {}) {
  const book = drawingBook(project);
  const kind = String(source?.kind || '');
  if (!STUDIO_DRAWING_TABLE_KINDS.includes(kind)) fail('DRAWING_TABLE_INPUT_INVALID', 'Drawing-table kind must be cut-list, hole, revision, or weld.');
  const sheetId = String(source?.sheetId || '');
  if (!book.sheets.some((entry) => entry.id === sheetId)) fail('DRAWING_SHEET_NOT_FOUND', 'Drawing table references a missing sheet.');
  const table = {
    id,
    kind,
    sheetId,
    name: text(source?.name || ({ 'cut-list': 'Cut list', hole: 'Hole table', revision: 'Revision table', weld: 'Weld table' })[kind], 'Drawing-table name'),
    positionMm: position(source?.positionMm || [12, 12]),
    widthMm: finite(source?.widthMm ?? 120, 'Drawing-table width', 40, 250),
  };
  const references = projectReferences(project);
  if (kind === 'cut-list') {
    if (!owns(source, 'sourceType')) {
      fail('DRAWING_TABLE_INPUT_INVALID', 'Cut-list sourceType is required.');
    }
    const sourceType = String(source.sourceType);
    if (!['body-axis', 'structural-member'].includes(sourceType)) {
      fail('DRAWING_TABLE_INPUT_INVALID', 'Cut-list sourceType must be body-axis or structural-member.');
    }
    table.sourceType = sourceType;
    if (sourceType === 'body-axis') {
      if (owns(source, 'sourceMemberIds')) {
        fail('DRAWING_TABLE_INPUT_INVALID', 'Body-axis cut lists cannot contain structural-member references.');
      }
      table.axis = ['x', 'y', 'z'].includes(source?.axis) ? source.axis : 'x';
      table.sourceBodyIds = uniqueIds(source?.sourceBodyIds, 'Cut list', 50);
      if (validateReferences) {
        const missing = table.sourceBodyIds.filter((bodyId) => !references.bodies.has(bodyId));
        if (missing.length) fail('DRAWING_TABLE_REFERENCE_MISSING', 'Cut list references one or more missing bodies.', { bodyIds: missing });
      }
    } else {
      structuralCutListShape(source);
      table.sourceMemberIds = uniqueIds(source?.sourceMemberIds, 'Structural-member cut list', 50);
      if (validateReferences) {
        const effectiveProject = effectiveStructuralProject(project).project;
        const effectiveReferences = projectReferences(effectiveProject);
        const missing = table.sourceMemberIds.filter((featureId) => !effectiveReferences.structuralMembers.has(featureId));
        if (missing.length) {
          fail(
            'DRAWING_TABLE_REFERENCE_MISSING',
            'Structural-member cut list references one or more missing, suppressed, rollback-excluded, or non-root members.',
            { featureIds: missing },
          );
        }
        for (const featureId of table.sourceMemberIds) assertedStructuralMember(effectiveProject, featureId);
      }
    }
  } else if (kind === 'hole') {
    table.sourceFeatureIds = uniqueIds(source?.sourceFeatureIds, 'Hole table', 100);
    if (validateReferences) {
      const missing = table.sourceFeatureIds.filter((featureId) => !references.holeFeatures.has(featureId));
      if (missing.length) fail('DRAWING_TABLE_REFERENCE_MISSING', 'Hole table references one or more missing Hole Wizard features.', { featureIds: missing });
    }
  } else if (kind === 'weld') {
    table.sourceFeatureIds = uniqueIds(source?.sourceFeatureIds, 'Weld table', 100);
    if (validateReferences) {
      const missing = table.sourceFeatureIds.filter((featureId) => !references.weldFeatures.has(featureId));
      if (missing.length) fail('DRAWING_TABLE_REFERENCE_MISSING', 'Weld table references one or more missing or suppressed weld-bead features.', { featureIds: missing });
      for (const featureId of table.sourceFeatureIds) assertedWeldBead(project, featureId, false);
    }
  } else {
    table.entries = revisionEntries(source?.entries);
  }
  return table;
}

function emptyGraph() {
  return { schema: STUDIO_DRAWING_TABLES_SCHEMA, sequence: 0, tables: [] };
}

function validateGraph(value, project, { validateReferences = false } = {}) {
  if (value == null) return emptyGraph();
  if (!value || typeof value !== 'object' || value.schema !== STUDIO_DRAWING_TABLES_SCHEMA
    || !Number.isInteger(value.sequence) || value.sequence < 0 || !Array.isArray(value.tables) || value.tables.length > 60) {
    fail('DRAWING_TABLES_INVALID', 'Drawing-table graph is invalid.');
  }
  const graph = clone(value);
  const ids = new Set();
  const names = new Set();
  let maximumSequence = 0;
  for (let index = 0; index < graph.tables.length; index += 1) {
    const source = graph.tables[index];
    if (!/^drawing-table-\d{6}$/u.test(source?.id || '') || ids.has(source.id)) fail('DRAWING_TABLES_INVALID', 'Drawing-table ids are missing or duplicated.');
    const table = tableRecord(source, project, source.id, { validateReferences });
    const nameKey = `${table.sheetId}:${table.name.toLowerCase()}`;
    if (names.has(nameKey)) fail('DRAWING_TABLES_INVALID', 'Drawing-table names must be unique on each sheet.');
    graph.tables[index] = table;
    ids.add(source.id);
    names.add(nameKey);
    maximumSequence = Math.max(maximumSequence, Number(source.id.slice('drawing-table-'.length)));
  }
  if (graph.sequence < maximumSequence) fail('DRAWING_TABLES_INVALID', 'Drawing-table sequence can collide with an existing id.');
  return graph;
}

function attach(project, graph) {
  const candidate = canonicalStudioV5Project(project);
  candidate.extensions = {
    ...(candidate.extensions || {}),
    drawingTables: validateGraph(graph, candidate, { validateReferences: false }),
  };
  return canonicalStudioV5Project(candidate);
}

export function inspectStudioDrawingTables(project) {
  return validateGraph(project?.extensions?.drawingTables, project, { validateReferences: false });
}

export function createStudioDrawingTable(project, input = {}) {
  const graph = inspectStudioDrawingTables(project);
  if (graph.tables.length >= 60) fail('DRAWING_TABLE_LIMIT_EXCEEDED', 'A project supports at most 60 drawing tables.');
  const id = `drawing-table-${String(++graph.sequence).padStart(6, '0')}`;
  const table = tableRecord(input, project, id, { validateReferences: true });
  if (graph.tables.some((entry) => entry.sheetId === table.sheetId && entry.name.toLowerCase() === table.name.toLowerCase())) {
    fail('DRAWING_TABLE_EXISTS', `Drawing table "${table.name}" already exists on that sheet.`);
  }
  graph.tables.push(table);
  return attach(project, graph);
}

export function updateStudioDrawingTable(project, input = {}) {
  const graph = inspectStudioDrawingTables(project);
  const table = graph.tables.find((entry) => entry.id === input.tableId);
  if (!table) fail('DRAWING_TABLE_NOT_FOUND', 'Requested drawing table does not exist.');
  const patch = input.patch && typeof input.patch === 'object' ? input.patch : {};
  if (patch.kind != null && patch.kind !== table.kind) fail('DRAWING_TABLE_INPUT_INVALID', 'Drawing-table kind cannot change during an update.');
  if (table.kind === 'cut-list' && patch.sourceType != null && patch.sourceType !== table.sourceType) {
    fail('DRAWING_TABLE_INPUT_INVALID', 'Cut-list sourceType cannot change during an update. Delete and recreate the table.');
  }
  const next = tableRecord({ ...table, ...patch }, project, table.id, { validateReferences: true });
  if (graph.tables.some((entry) => entry.id !== table.id && entry.sheetId === next.sheetId && entry.name.toLowerCase() === next.name.toLowerCase())) {
    fail('DRAWING_TABLE_EXISTS', `Drawing table "${next.name}" already exists on that sheet.`);
  }
  Object.assign(table, next);
  return attach(project, graph);
}

export function deleteStudioDrawingTable(project, tableId) {
  const graph = inspectStudioDrawingTables(project);
  const index = graph.tables.findIndex((entry) => entry.id === tableId);
  if (index < 0) fail('DRAWING_TABLE_NOT_FOUND', 'Requested drawing table does not exist.');
  graph.tables.splice(index, 1);
  return attach(project, graph);
}

function exactDrawingResponse(response, project) {
  if (!response || response.kind !== 'drawing-result' || response.errors?.length
    || response.manifest?.exactProjectionEvidence?.kind !== 'occt-hlr-exact') {
    fail('DRAWING_TABLE_EXACT_REQUIRED', 'Associative drawing tables require a successful exact OCCT drawing result.');
  }
  const evidence = response.manifest.exactProjectionEvidence;
  const documentHash = evidence.documentHash || evidence.revisionKey;
  if (!project || typeof documentHash !== 'string' || documentHash !== studioV5CanonicalHash(project)) {
    fail('DRAWING_TABLE_REFERENCE_STALE', 'Associative drawing tables require exact evidence for the current document revision.');
  }
  return documentHash;
}

function exactBodies(response, project) {
  exactDrawingResponse(response, project);
  const byId = new Map();
  for (const body of response.bodies || []) {
    const id = String(body.sourceBodyId || body.bodyId || '');
    if (!id || body.patternInstance || byId.has(id)) continue;
    const bounds = body.geometry?.bounds;
    if (body.geometry?.valid !== true || body.geometry?.brepValid !== true || body.geometry?.solidCount !== 1
      || !Array.isArray(bounds) || bounds.length !== 2 || bounds.some((entry) => !Array.isArray(entry) || entry.length !== 3 || entry.some((value) => !Number.isFinite(value)))) continue;
    byId.set(id, body);
  }
  return byId;
}

function projectBodies(project) {
  return new Map((project.partDefinitions || []).flatMap((part) => (part.bodies || []).map((body) => [body.id, { body, part }])));
}

function projectFeatures(project) {
  return new Map((project.partDefinitions || []).flatMap((part) => (part.features || []).map((feature) => [feature.id, { feature, part }])));
}

function exactBody(response, bodyId, label) {
  const matches = (response.bodies || []).filter((entry) => !entry.patternInstance
    && String(entry.sourceBodyId || entry.bodyId || '') === bodyId);
  if (matches.length !== 1) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `${label} "${bodyId}" did not resolve to exactly one current exact body.`, {
      bodyId,
      matchCount: matches.length,
    });
  }
  const body = matches[0];
  const geometry = body.geometry;
  if (geometry?.valid !== true || geometry?.brepValid !== true || geometry?.solidCount !== 1
    || typeof geometry.volume !== 'number' || !Number.isFinite(geometry.volume) || !(geometry.volume > 0)) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `${label} "${bodyId}" has no current valid one-solid B-rep with positive exact volume.`, { bodyId });
  }
  return body;
}

function exactLineEdge(body, bodyId, edgeName, label) {
  const topology = body.topology;
  const matches = Array.isArray(topology?.edges)
    ? topology.edges.filter((entry) => entry?.name === edgeName)
    : [];
  if (topology?.schema !== 'partmode.drawing-topology-evidence/v1' || matches.length !== 1) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `${label} persistent edge "${edgeName}" on body "${bodyId}" did not resolve one-to-one in current exact topology.`, {
      bodyId,
      edgeName,
      matchCount: matches.length,
    });
  }
  const edge = matches[0];
  if (edge.geomType !== 'LINE' || typeof edge.lengthMm !== 'number' || !Number.isFinite(edge.lengthMm) || !(edge.lengthMm > 0)
    || !Array.isArray(edge.endpoints) || edge.endpoints.length !== 2
    || edge.endpoints.some((point) => !Array.isArray(point) || point.length !== 3
      || point.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate)))) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `${label} persistent edge "${edgeName}" on body "${bodyId}" lacks exact finite LINE length and endpoints.`, {
      bodyId,
      edgeName,
    });
  }
  const endpointLengthMm = Math.hypot(...edge.endpoints[1].map((coordinate, axis) => coordinate - edge.endpoints[0][axis]));
  const coordinateScale = Math.max(1, ...edge.endpoints.flat().map(Math.abs));
  const tolerance = Math.max(1e-7, edge.lengthMm * 1e-9, coordinateScale * Number.EPSILON * 256);
  if (!(endpointLengthMm > 0) || Math.abs(endpointLengthMm - edge.lengthMm) > tolerance) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `${label} persistent LINE edge "${edgeName}" has inconsistent exact endpoint and length evidence.`, {
      bodyId,
      edgeName,
      endpointLengthMm,
      lengthMm: edge.lengthMm,
      tolerance,
    });
  }
  return { name: edgeName, lengthMm: edge.lengthMm, endpoints: clone(edge.endpoints), tolerance };
}

function matchingSupportEdgeLength(left, right, featureId) {
  const direct = Math.max(
    Math.hypot(...left.endpoints[0].map((coordinate, axis) => coordinate - right.endpoints[0][axis])),
    Math.hypot(...left.endpoints[1].map((coordinate, axis) => coordinate - right.endpoints[1][axis])),
  );
  const reversed = Math.max(
    Math.hypot(...left.endpoints[0].map((coordinate, axis) => coordinate - right.endpoints[1][axis])),
    Math.hypot(...left.endpoints[1].map((coordinate, axis) => coordinate - right.endpoints[0][axis])),
  );
  const tolerance = Math.max(left.tolerance, right.tolerance, Math.max(left.lengthMm, right.lengthMm) * 1e-9);
  if (Math.abs(left.lengthMm - right.lengthMm) > tolerance || Math.min(direct, reversed) > tolerance) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Weld-bead feature "${featureId}" support edges no longer describe the same exact seam.`, {
      featureId,
      leftLengthMm: left.lengthMm,
      rightLengthMm: right.lengthMm,
      endpointMismatchMm: Math.min(direct, reversed),
      tolerance,
    });
  }
  return left.lengthMm;
}

function assertedWeldBead(project, featureId, partContract = true) {
  const records = [];
  for (const part of project.partDefinitions || []) {
    for (const feature of part.features || []) if (feature.id === featureId) records.push({ feature, part });
  }
  if (records.length !== 1 || records[0].feature.type !== 'weld-bead' || records[0].feature.suppressed === true) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Weld-table feature "${featureId}" is missing, ambiguous, suppressed, or is not a weld bead.`, {
      featureId,
      matchCount: records.length,
    });
  }
  try {
    if (!partContract) {
      return {
        ...records[0],
        checked: { recipe: assertStudioWeldBeadFeature(records[0].feature, `feature[${featureId}]`) },
      };
    }
    const parameters = studioV5ParameterValues(project, records[0].part);
    return {
      ...records[0],
      checked: assertStudioWeldBeadPart(
        records[0].part,
        records[0].feature,
        `feature[${featureId}]`,
        (value) => evaluateStudioV5Expression(value, parameters),
      ),
    };
  } catch (error) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Weld-table feature "${featureId}" no longer satisfies its persistent document contract.`, {
      featureId,
      reason: String(error?.message || error),
    });
  }
}

const structuralDot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);
const structuralAddScaled = (point, direction, distance) => point.map((value, index) => value + direction[index] * distance);

function structuralUnit(vector, label) {
  const length = Math.hypot(...vector);
  if (!(length > 1e-9) || !Number.isFinite(length)) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `${label} is not a finite nonzero exact direction.`);
  }
  return vector.map((value) => value / length);
}

function assertedStructuralMember(project, memberId) {
  const records = [];
  for (const part of project.partDefinitions || []) {
    for (const feature of part.features || []) if (feature.id === memberId) records.push({ feature, part });
  }
  const rootPartId = project?.rootDocument?.kind === 'part' ? project.rootDocument.partId : null;
  if (records.length !== 1 || records[0].part.id !== rootPartId || records[0].feature.type !== 'sweep'
    || !records[0].feature.extensions?.structuralMember || records[0].feature.suppressed === true) {
    fail(
      'DRAWING_TABLE_REFERENCE_STALE',
      `Structural cut-list member "${memberId}" is missing, ambiguous, suppressed, non-root, or is not a structural member.`,
      { memberId, matchCount: records.length },
    );
  }
  const { feature, part } = records[0];
  const rollbackPosition = part.metadata?.rollbackFeatureId
    ? part.featureOrder.indexOf(part.metadata.rollbackFeatureId)
    : -1;
  const enabledIds = new Set(part.featureOrder.slice(0, rollbackPosition >= 0 ? rollbackPosition + 1 : part.featureOrder.length));
  if (!enabledIds.has(memberId)) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural cut-list member "${memberId}" is excluded by the current rollback position.`, { memberId });
  }
  const bodies = (part.bodies || []).filter((body) => body.createdByFeatureId === memberId);
  if (bodies.length !== 1 || bodies[0].suppressed === true) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural cut-list member "${memberId}" has no unique current body.`, {
      memberId,
      bodyCount: bodies.length,
    });
  }
  const body = bodies[0];
  try {
    const parameters = studioV5ParameterValues(project, part);
    const evaluate = (value) => evaluateStudioV5Expression(value, parameters);
    const checked = assertStudioStructuralMemberPart(part, feature, `feature[${memberId}]`, evaluate);
    const endpoints = {
      start: {
        kind: 'square', treatmentFeatureId: null,
        point: clone(checked.evaluatedPath[0]), normal: clone(checked.currentTangent), facePrefix: null,
      },
      end: {
        kind: 'square', treatmentFeatureId: null,
        point: clone(checked.evaluatedPath[1]), normal: clone(checked.currentTangent), facePrefix: null,
      },
    };
    const featureById = new Map((part.features || []).map((entry) => [entry.id, entry]));
    const activeFeatures = (body.featureIds || [])
      .map((id) => featureById.get(id))
      .filter((entry) => entry && entry.suppressed !== true && enabledIds.has(entry.id));
    if (activeFeatures.filter((entry) => entry.id === memberId).length !== 1) {
      throw new Error('structural-member creation feature is detached from its body history');
    }
    for (const modifier of activeFeatures.filter((entry) => entry.id !== memberId)) {
      if (modifier.type !== 'weldment-treatment' || !modifier.extensions?.weldmentTreatment) {
        throw new Error(`unsupported downstream modifier "${modifier.id}" is present on the structural-member body`);
      }
      const treatment = assertStudioWeldmentTreatmentPart(
        part,
        modifier,
        `feature[${modifier.id}]`,
        evaluate,
      );
      let end;
      let descriptor;
      if (treatment.recipe.kind === 'trim-extend'
        && treatment.recipe.memberId === memberId && treatment.recipe.memberBodyId === body.id) {
        end = treatment.recipe.end;
        descriptor = {
          kind: 'square',
          treatmentFeatureId: modifier.id,
          point: structuralAddScaled(
            treatment.endpoint,
            treatment.away,
            treatment.recipe.mode === 'trim' ? treatment.recipe.distance : -treatment.recipe.distance,
          ),
          normal: clone(checked.currentTangent),
          facePrefix: null,
        };
      } else if (treatment.recipe.kind === 'corner'
        && treatment.recipe.targetMemberId === memberId && treatment.recipe.targetBodyId === body.id) {
        end = treatment.recipe.targetEnd;
        descriptor = treatment.recipe.style === 'cope'
          ? {
              kind: 'cope', treatmentFeatureId: modifier.id, point: clone(treatment.joint.point), normal: null,
              facePrefix: `weldment:${modifier.id}/other-member/`,
            }
          : {
              kind: 'miter', treatmentFeatureId: modifier.id, point: clone(treatment.joint.point),
              normal: structuralUnit(
                treatment.joint.leftAway.map((value, index) => value - treatment.joint.rightAway[index]),
                `Miter treatment "${modifier.id}" plane`,
              ),
              facePrefix: null,
            };
      } else {
        throw new Error(`treatment "${modifier.id}" does not exclusively modify this structural member`);
      }
      if (endpoints[end].treatmentFeatureId) throw new Error(`multiple active treatments claim the ${end} endpoint`);
      endpoints[end] = descriptor;
    }
    return { feature, part, body, checked, endpoints, activeFeatures };
  } catch (error) {
    if (error instanceof StudioDrawingTablesError) throw error;
    fail(
      'DRAWING_TABLE_REFERENCE_STALE',
      `Structural cut-list member "${memberId}" no longer satisfies its exact persistent document contract.`,
      { memberId, reason: String(error?.message || error) },
    );
  }
}

function resolvedCutList(table, response, project) {
  const exact = exactBodies(response, project);
  const definitions = projectBodies(project);
  const axisIndex = { x: 0, y: 1, z: 2 }[table.axis];
  const rows = table.sourceBodyIds.map((bodyId, index) => {
    const body = exact.get(bodyId);
    const definition = definitions.get(bodyId);
    if (!body || !definition) fail('DRAWING_TABLE_REFERENCE_STALE', `Cut-list body "${bodyId}" has no current exact solid evidence.`);
    const lengthMm = body.geometry.bounds[1][axisIndex] - body.geometry.bounds[0][axisIndex];
    if (!(lengthMm > 0)) fail('DRAWING_TABLE_REFERENCE_STALE', `Cut-list body "${bodyId}" has no positive ${table.axis.toUpperCase()} extent.`);
    return [index + 1, definition.body.name || bodyId, definition.part.metadata?.material || definition.body.materialId || '', 1, Math.round(lengthMm * 1000) / 1000];
  });
  return { headers: ['ITEM', 'BODY', 'MATERIAL', 'QTY', `LENGTH ${table.axis.toUpperCase()} mm`], rows, evidence: { kind: 'exact-brep-bounds', bodyIds: [...table.sourceBodyIds] } };
}

function finiteVector(value, label) {
  if (!Array.isArray(value) || value.length !== 3
    || value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `${label} must contain three finite exact coordinates.`);
  }
  return value;
}

function effectiveStructuralProject(project) {
  try {
    const authoredProject = canonicalStudioV5Project(project);
    if (authoredProject.rootDocument?.kind !== 'part') {
      fail('DRAWING_TABLE_REFERENCE_STALE', 'Structural-member cut lists require a root part document.');
    }
    const configurationSets = (authoredProject.partConfigurationSets || [])
      .filter((entry) => entry?.partId === authoredProject.rootDocument.partId);
    if (configurationSets.length > 1) {
      fail('DRAWING_TABLE_REFERENCE_STALE', 'Structural-member cut lists require one unambiguous root-part configuration set.');
    }
    if (!configurationSets.length) {
      return { project: authoredProject, hash: studioV5CanonicalHash(authoredProject) };
    }
    const applied = applyStudioPartConfiguration(
      authoredProject,
      configurationSets[0],
      configurationSets[0].activeConfigurationId,
    );
    return { project: applied.project, hash: studioV5CanonicalHash(applied.project) };
  } catch (error) {
    if (error instanceof StudioDrawingTablesError) throw error;
    fail('DRAWING_TABLE_REFERENCE_STALE', 'Structural-member cut-list configuration evidence is invalid.', {
      reason: String(error?.message || error),
    });
  }
}

function structuralEvidenceMap(response, project) {
  const documentHash = exactDrawingResponse(response, project);
  const evidence = response.manifest?.structuralMemberCutEvidence;
  const projection = response.manifest?.exactProjectionEvidence;
  const effective = effectiveStructuralProject(project);
  const expectedEffectiveHash = effective.hash;
  if (evidence?.schema !== 'partmode.structural-member-cut-evidence/v1'
    || evidence.kind !== 'occt-exact-structural-member-cuts'
    || evidence.documentHash !== documentHash
    || projection?.effectiveDocumentHash !== expectedEffectiveHash
    || evidence.effectiveDocumentHash !== expectedEffectiveHash
    || evidence.lengthBasis !== 'exact-brep-axial-envelope'
    || evidence.angleConvention !== 'degrees-off-square'
    || !Array.isArray(evidence.members) || !Array.isArray(evidence.errors)) {
    fail('DRAWING_TABLE_EXACT_REQUIRED', 'Structural-member cut lists require current, hash-bound exact OCCT cut evidence.');
  }
  const byId = new Map();
  for (const member of evidence.members) {
    if (typeof member?.memberId !== 'string' || !member.memberId || byId.has(member.memberId)) {
      fail('DRAWING_TABLE_REFERENCE_STALE', 'Structural-member cut evidence contains missing or duplicate member identities.');
    }
    byId.set(member.memberId, member);
  }
  const errorIds = new Set();
  for (const error of evidence.errors) {
    if (typeof error?.memberId !== 'string' || !error.memberId || errorIds.has(error.memberId)
      || (error.bodyId !== null && typeof error.bodyId !== 'string')
      || typeof error.message !== 'string' || !error.message
      || byId.has(error.memberId)) {
      fail('DRAWING_TABLE_REFERENCE_STALE', 'Structural-member cut evidence contains malformed, duplicate, or contradictory worker errors.');
    }
    errorIds.add(error.memberId);
  }
  return {
    documentHash,
    effectiveDocumentHash: expectedEffectiveHash,
    effectiveProject: effective.project,
    evidence,
    byId,
  };
}

function validatedStructuralTopology(member, record) {
  const topology = member?.topology;
  const geometry = member?.geometry;
  if (geometry?.valid !== true || geometry?.brepValid !== true || geometry?.solidCount !== 1
    || typeof geometry.volume !== 'number' || !Number.isFinite(geometry.volume) || !(geometry.volume > 0)
    || !/^[0-9a-f]{64}$/u.test(member?.brepSha256 || '')
    || !Number.isInteger(member?.brepBytes) || member.brepBytes <= 0
    || !/^[0-9a-f]{64}$/u.test(member?.checkpointBrepSha256 || '')
    || !Number.isInteger(member?.checkpointBrepBytes) || member.checkpointBrepBytes <= 0
    || member.checkpointBrepSha256 !== member.brepSha256 || member.checkpointBrepBytes !== member.brepBytes
    || !/^[0-9a-f]{64}$/u.test(member?.brepTopologyBindingSha256 || '')
    || member.checkpointFeatureId !== record.activeFeatures.at(-1)?.id
    || topology?.schema !== 'partmode.structural-member-cut-topology/v1'
    || !/^[0-9a-f]{64}$/u.test(topology.sha256 || '')
    || !Array.isArray(topology.faces) || !Array.isArray(topology.edges) || !Array.isArray(topology.vertices)
    || !Array.isArray(topology.diagnostics) || topology.diagnostics.length !== 0) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" lacks valid final one-solid B-rep and topology evidence.`);
  }
  const counts = topology.counts;
  if (counts?.faces !== topology.faces.length || counts.namedFaces !== topology.faces.length
    || counts.edges !== topology.edges.length || counts.namedEdges !== topology.edges.length
    || counts.vertices !== topology.vertices.length || counts.namedVertices !== topology.vertices.length
    || geometry.faceCount !== counts.faces || geometry.edgeCount !== counts.edges || geometry.vertexCount !== counts.vertices) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" topology coverage is incomplete or detached from its exact body.`);
  }
  const validateNamed = (entries, label) => {
    const names = new Set();
    for (const entry of entries) {
      if (typeof entry?.name !== 'string' || !entry.name || names.has(entry.name)) {
        fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" has missing or duplicate persistent ${label} names.`);
      }
      names.add(entry.name);
    }
    return names;
  };
  validateNamed(topology.faces, 'face');
  validateNamed(topology.edges, 'edge');
  validateNamed(topology.vertices, 'vertex');
  for (const face of topology.faces) {
    if (face.geomType !== 'PLANE') {
      fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" contains unsupported nonplanar exact cut-list topology.`);
    }
    finiteVector(face.point, `Structural-member "${record.feature.id}" face point`);
    const normal = finiteVector(face.normal, `Structural-member "${record.feature.id}" face normal`);
    if (Math.abs(Math.hypot(...normal) - 1) > 1e-9) {
      fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" face normal is not precise normalized OCCT evidence.`);
    }
  }
  if (topology.edges.some((edge) => edge.geomType !== 'LINE')) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" contains unsupported nonlinear exact cut-list topology.`);
  }
  for (const vertex of topology.vertices) finiteVector(vertex.point, `Structural-member "${record.feature.id}" vertex point`);
  const fingerprint = studioV5Sha256Hex(JSON.stringify({
    counts: topology.counts,
    faces: topology.faces,
    edges: topology.edges,
    vertices: topology.vertices,
    diagnostics: topology.diagnostics,
  }));
  if (fingerprint !== topology.sha256) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" exact topology fingerprint is stale or malformed.`);
  }
  const binding = studioV5Sha256Hex(JSON.stringify({
    brepSha256: member.brepSha256,
    brepBytes: member.brepBytes,
    topologySha256: topology.sha256,
  }));
  if (binding !== member.brepTopologyBindingSha256) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" exact B-rep/topology binding is stale or malformed.`);
  }
  return topology;
}

function structuralCoordinateTolerance(points, length = 1) {
  const scale = Math.max(1, Math.abs(length), ...points.flat().map(Math.abs));
  return Math.max(1e-7, scale * 1e-9, scale * Number.EPSILON * 256);
}

function validatedStructuralEndpoint(member, record, topology, end, axis, coordinateTolerance) {
  const actual = member?.[end];
  const expected = record.endpoints[end];
  if (!actual || actual.kind !== expected.kind || actual.treatmentFeatureId !== expected.treatmentFeatureId
    || !Array.isArray(actual.faceNames) || !actual.faceNames.length || new Set(actual.faceNames).size !== actual.faceNames.length) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" ${end} cut classification is stale or ambiguous.`);
  }
  const faces = actual.faceNames.map((name) => topology.faces.filter((entry) => entry.name === name));
  if (faces.some((matches) => matches.length !== 1)) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" ${end} cut faces do not resolve one-to-one.`);
  }
  const resolvedFaces = faces.map((matches) => matches[0]);
  if (expected.kind === 'cope') {
    const completeCopeFaceNames = topology.faces
      .filter((face) => face.name.startsWith(expected.facePrefix))
      .map((face) => face.name)
      .sort();
    if (actual.angleOffSquareDeg !== null
      || resolvedFaces.some((face) => !face.name.startsWith(expected.facePrefix))
      || JSON.stringify([...actual.faceNames].sort()) !== JSON.stringify(completeCopeFaceNames)) {
      fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" ${end} cope must retain exact profiled faces and no scalar angle.`);
    }
    return { ...clone(actual), angleOffSquareDeg: null };
  }
  if (resolvedFaces.length !== 1 || typeof actual.angleOffSquareDeg !== 'number'
    || !Number.isFinite(actual.angleOffSquareDeg) || actual.angleOffSquareDeg < 0 || actual.angleOffSquareDeg > 90) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" ${end} planar cut lacks one exact finite angle.`);
  }
  const face = resolvedFaces[0];
  const expectedNormal = structuralUnit(expected.normal, `Structural-member "${record.feature.id}" ${end} expected plane`);
  const alignment = Math.abs(structuralDot(face.normal, expectedNormal));
  const planeDistance = Math.abs(structuralDot(
    face.point.map((value, index) => value - expected.point[index]),
    expectedNormal,
  ));
  if (alignment < 1 - 1e-8 || planeDistance > coordinateTolerance) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" ${end} face no longer matches its persistent treatment plane.`, {
      alignment,
      planeDistance,
      tolerance: coordinateTolerance,
    });
  }
  const axisAlignment = Math.max(-1, Math.min(1, Math.abs(structuralDot(face.normal, axis))));
  const recomputed = axisAlignment >= 1 - 1e-14 ? 0 : Math.acos(axisAlignment) * 180 / Math.PI;
  const angleTolerance = Math.max(1e-9, Math.abs(recomputed) * 1e-10);
  if (Math.abs(actual.angleOffSquareDeg - recomputed) > angleTolerance) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" ${end} angle is detached from its precise current OCCT face normal.`);
  }
  return clone(actual);
}

function publishedStructuralTopologyMatches(published, structural) {
  const byName = (entries) => {
    const map = new Map();
    for (const entry of entries || []) {
      if (typeof entry?.name !== 'string' || !entry.name || map.has(entry.name)) return null;
      map.set(entry.name, entry);
    }
    return map;
  };
  const publishedFaces = byName(published?.faces);
  const publishedEdges = byName(published?.edges);
  const publishedVertices = byName(published?.vertices);
  if (!publishedFaces || !publishedEdges || !publishedVertices
    || publishedFaces.size !== structural.faces.length
    || publishedEdges.size !== structural.edges.length
    || publishedVertices.size !== structural.vertices.length) return false;
  const pointMatches = (left, right) => Array.isArray(left) && left.length === 3
    && left.every((value, index) => typeof value === 'number' && Number.isFinite(value)
      && Math.abs(value - right[index]) <= 2e-9);
  return structural.faces.every((face) => {
    const candidate = publishedFaces.get(face.name);
    return candidate?.geomType === face.geomType && pointMatches(candidate.point, face.point);
  }) && structural.edges.every((edge) => publishedEdges.get(edge.name)?.geomType === edge.geomType)
    && structural.vertices.every((vertex) => pointMatches(publishedVertices.get(vertex.name)?.point, vertex.point));
}

function validatedStructuralMemberEvidence(member, record, response) {
  if (member?.bodyId !== record.body.id || member?.profile?.familyId !== record.checked.recipe.familyId
    || member.profile?.presetId !== record.checked.recipe.presetId
    || member.profile?.designation !== record.checked.recipe.designation) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" exact evidence is detached from its current body or profile.`);
  }
  const topology = validatedStructuralTopology(member, record);
  const publishedBody = exactBody(response, record.body.id, 'Structural-member body');
  const publishedCounts = publishedBody.topology?.counts;
  if (publishedBody.structuralMemberId !== record.feature.id
    || publishedBody.brepSha256 !== member.brepSha256 || publishedBody.brepBytes !== member.brepBytes
    || publishedBody.structuralTopologySha256 !== topology.sha256
    || publishedBody.brepTopologyBindingSha256 !== member.brepTopologyBindingSha256
    || JSON.stringify(publishedBody.geometry) !== JSON.stringify(member.geometry)
    || publishedBody.topology?.schema !== 'partmode.drawing-topology-evidence/v1'
    || !Array.isArray(publishedBody.topology.diagnostics) || publishedBody.topology.diagnostics.length !== 0
    || publishedCounts?.faces !== topology.counts.faces || publishedCounts.namedFaces !== topology.counts.namedFaces
    || publishedCounts?.edges !== topology.counts.edges || publishedCounts.namedEdges !== topology.counts.namedEdges
    || publishedCounts?.vertices !== topology.counts.vertices || publishedCounts.namedVertices !== topology.counts.namedVertices
    || !publishedStructuralTopologyMatches(publishedBody.topology, topology)) {
    fail(
      'DRAWING_TABLE_REFERENCE_STALE',
      `Structural-member "${record.feature.id}" cut evidence does not match its independently published final exact body.`,
      { memberId: record.feature.id, bodyId: record.body.id },
    );
  }
  const origin = finiteVector(member.axis?.origin, `Structural-member "${record.feature.id}" axis origin`);
  const axis = finiteVector(member.axis?.direction, `Structural-member "${record.feature.id}" axis direction`);
  if (Math.abs(Math.hypot(...axis) - 1) > 1e-9
    || Math.hypot(...axis.map((value, index) => value - record.checked.currentTangent[index])) > 1e-9) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" exact axis is detached from its evaluated straight path.`);
  }
  const points = topology.vertices.map((entry) => entry.point);
  const coordinateTolerance = structuralCoordinateTolerance([...points, origin], member.lengthMm);
  if (Math.hypot(...origin.map((value, index) => value - record.checked.evaluatedPath[0][index])) > coordinateTolerance) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" exact axis origin is detached from its evaluated path.`);
  }
  const projected = topology.vertices.map((entry) => ({
    name: entry.name,
    projection: structuralDot(entry.point.map((value, index) => value - origin[index]), axis),
  }));
  const minimumMm = Math.min(...projected.map((entry) => entry.projection));
  const maximumMm = Math.max(...projected.map((entry) => entry.projection));
  const lengthMm = maximumMm - minimumMm;
  const envelope = member.axialEnvelope;
  const expectedStartNames = projected.filter((entry) => Math.abs(entry.projection - minimumMm) <= coordinateTolerance)
    .map((entry) => entry.name).sort();
  const expectedEndNames = projected.filter((entry) => Math.abs(entry.projection - maximumMm) <= coordinateTolerance)
    .map((entry) => entry.name).sort();
  if (!(lengthMm > 1e-7) || typeof member.lengthMm !== 'number' || !Number.isFinite(member.lengthMm)
    || Math.abs(member.lengthMm - lengthMm) > coordinateTolerance
    || typeof envelope?.minimumMm !== 'number' || typeof envelope.maximumMm !== 'number'
    || Math.abs(envelope.minimumMm - minimumMm) > coordinateTolerance
    || Math.abs(envelope.maximumMm - maximumMm) > coordinateTolerance
    || JSON.stringify([...(envelope.startVertexNames || [])].sort()) !== JSON.stringify(expectedStartNames)
    || JSON.stringify([...(envelope.endVertexNames || [])].sort()) !== JSON.stringify(expectedEndNames)) {
    fail('DRAWING_TABLE_REFERENCE_STALE', `Structural-member "${record.feature.id}" length is not its current exact B-rep axial envelope.`);
  }
  return {
    member,
    start: validatedStructuralEndpoint(member, record, topology, 'start', axis, coordinateTolerance),
    end: validatedStructuralEndpoint(member, record, topology, 'end', axis, coordinateTolerance),
    lengthMm,
  };
}

function resolvedStructuralCutList(table, response, project) {
  const exact = structuralEvidenceMap(response, project);
  const resolved = table.sourceMemberIds.map((memberId, index) => {
    const record = assertedStructuralMember(exact.effectiveProject, memberId);
    const member = exact.byId.get(memberId);
    if (!member) {
      const workerError = exact.evidence.errors.find((entry) => entry?.memberId === memberId);
      fail(
        'DRAWING_TABLE_REFERENCE_STALE',
        `Structural-member "${memberId}" has no current exact cut evidence.`,
        { memberId, reason: workerError?.message || null },
      );
    }
    const validated = validatedStructuralMemberEvidence(member, record, response);
    const material = record.part.metadata?.material || record.body.materialId || '';
    return {
      row: [
        index + 1,
        record.feature.name || record.body.name || memberId,
        record.checked.recipe.designation,
        material,
        1,
        validated.lengthMm,
        validated.start.angleOffSquareDeg === null ? 'COPE' : validated.start.angleOffSquareDeg,
        validated.end.angleOffSquareDeg === null ? 'COPE' : validated.end.angleOffSquareDeg,
      ],
      evidence: clone(member),
    };
  });
  return {
    headers: ['ITEM', 'MEMBER', 'PROFILE', 'MATERIAL', 'QTY', 'LENGTH mm', 'START ° OFF SQ', 'END ° OFF SQ'],
    rows: resolved.map((entry) => entry.row),
    evidence: {
      kind: 'exact-structural-member-cuts',
      documentHash: exact.documentHash,
      effectiveDocumentHash: exact.effectiveDocumentHash,
      lengthBasis: exact.evidence.lengthBasis,
      angleConvention: exact.evidence.angleConvention,
      memberIds: [...table.sourceMemberIds],
      bodyIds: resolved.map((entry) => entry.evidence.bodyId),
      members: resolved.map((entry) => entry.evidence),
    },
  };
}

function resolvedHoleTable(table, response, project) {
  exactDrawingResponse(response, project);
  if (!(response.bodies || []).some((body) => body.geometry?.valid === true && body.geometry?.brepValid === true && body.geometry?.solidCount === 1)) {
    fail('DRAWING_TABLE_EXACT_REQUIRED', 'Hole table requires at least one current exact solid.');
  }
  const definitions = projectFeatures(project);
  const rows = table.sourceFeatureIds.map((featureId, index) => {
    const record = definitions.get(featureId);
    if (!record) fail('DRAWING_TABLE_REFERENCE_STALE', `Hole-table feature "${featureId}" no longer exists.`);
    if (record.feature.suppressed === true) fail('DRAWING_TABLE_REFERENCE_STALE', `Hole-table feature "${featureId}" is suppressed.`);
    const definition = assertStudioHoleWizardFeature(record.feature, `feature[${featureId}]`);
    return [String.fromCharCode(65 + index), definition.center[0], definition.center[1], studioHoleWizardCallout(record.feature.extensions.holeWizard)];
  });
  return { headers: ['TAG', 'X mm', 'Y mm', 'HOLE CALLOUT'], rows, evidence: { kind: 'hole-wizard-exact-document', featureIds: [...table.sourceFeatureIds] } };
}

function resolvedWeldTable(table, response, project) {
  const documentHash = exactDrawingResponse(response, project);
  const beads = table.sourceFeatureIds.map((featureId, index) => {
    const record = assertedWeldBead(project, featureId);
    const { recipe, createdBody } = record.checked;
    const beadBody = exactBody(response, createdBody.id, 'Weld-bead body');
    const beadCounts = beadBody.topology?.counts;
    if (beadBody.geometry.faceCount !== 5 || beadBody.geometry.edgeCount !== 9 || beadBody.geometry.vertexCount !== 6
      || beadCounts?.faces !== 5 || beadCounts?.namedFaces !== 5
      || beadCounts?.edges !== 9 || beadCounts?.namedEdges !== 9
      || beadCounts?.vertices !== 6 || beadCounts?.namedVertices !== 6
      || !Array.isArray(beadBody.topology?.diagnostics) || beadBody.topology.diagnostics.length !== 0) {
      fail('DRAWING_TABLE_REFERENCE_STALE', `Weld-bead feature "${featureId}" lacks complete canonical triangular-prism topology evidence.`, {
        featureId,
        bodyId: createdBody.id,
        geometry: {
          faces: beadBody.geometry.faceCount,
          edges: beadBody.geometry.edgeCount,
          vertices: beadBody.geometry.vertexCount,
        },
        topologyCounts: beadCounts || null,
        topologyDiagnostics: beadBody.topology?.diagnostics || null,
      });
    }
    const supports = recipe.supports.map((support) => {
      const sourceBody = exactBody(response, support.bodyId, `Weld-bead ${support.role} body`);
      const edge = exactLineEdge(sourceBody, support.bodyId, support.edge.name, `Weld-bead ${support.role}`);
      return { role: support.role, bodyId: support.bodyId, edge };
    });
    const lengthMm = matchingSupportEdgeLength(supports[0].edge, supports[1].edge, featureId);
    const expectedVolumeMm3 = 0.5 * recipe.sizeMm * recipe.sizeMm * lengthMm;
    const volumeMm3 = beadBody.geometry.volume;
    const volumeToleranceMm3 = Math.max(1e-6, expectedVolumeMm3 * 1e-8);
    if (!Number.isFinite(expectedVolumeMm3) || !(expectedVolumeMm3 > 0)
      || Math.abs(volumeMm3 - expectedVolumeMm3) > volumeToleranceMm3) {
      fail('DRAWING_TABLE_REFERENCE_STALE', `Weld-bead feature "${featureId}" exact body volume does not match its 90-degree equal-leg fillet contract.`, {
        featureId,
        bodyId: createdBody.id,
        volumeMm3,
        expectedVolumeMm3,
        toleranceMm3: volumeToleranceMm3,
      });
    }
    return {
      row: [index + 1, record.feature.name || featureId, recipe.kind.toUpperCase(), recipe.sizeMm, lengthMm, recipe.process, volumeMm3],
      evidence: {
        featureId,
        bodyId: createdBody.id,
        sourceBodyIds: supports.map((support) => support.bodyId),
        edgeNames: supports.map((support) => support.edge.name),
        lengthMm,
        sizeMm: recipe.sizeMm,
        volumeMm3,
      },
    };
  });
  return {
    headers: ['ITEM', 'BEAD', 'TYPE', 'SIZE mm', 'LENGTH mm', 'PROCESS', 'VOLUME mm^3'],
    rows: beads.map((entry) => entry.row),
    evidence: {
      kind: 'exact-modeled-weld-beads',
      documentHash,
      featureIds: beads.map((entry) => entry.evidence.featureId),
      bodyIds: beads.map((entry) => entry.evidence.bodyId),
      sourceBodyIds: [...new Set(beads.flatMap((entry) => entry.evidence.sourceBodyIds))],
      lengthsMm: beads.map((entry) => entry.evidence.lengthMm),
      beads: beads.map((entry) => entry.evidence),
    },
  };
}

function resolvedRevisionTable(table) {
  return {
    headers: ['REV', 'DESCRIPTION', 'DATE', 'APPROVED'],
    rows: table.entries.map((entry) => [entry.revision, entry.description, entry.date, entry.approvedBy]),
    evidence: { kind: 'controlled-document-records', revisions: table.entries.map((entry) => entry.revision) },
  };
}

export function resolveStudioDrawingSheetTables(book, graphValue, sheetId, response, project) {
  if (!book || book.schema !== 'partmode.drawing-book/v1' || !book.sheets.some((entry) => entry.id === sheetId)) {
    fail('DRAWING_SHEET_NOT_FOUND', 'Requested drawing sheet does not exist.');
  }
  const graph = validateGraph(graphValue, project, { validateReferences: true });
  return {
    schema: 'partmode.drawing-sheet-tables/v1',
    sheetId,
    tables: graph.tables.filter((entry) => entry.sheetId === sheetId).map((table) => ({
      ...clone(table),
      ...(table.kind === 'cut-list'
        ? (table.sourceType === 'structural-member'
            ? resolvedStructuralCutList(table, response, project)
            : resolvedCutList(table, response, project))
        : table.kind === 'hole' ? resolvedHoleTable(table, response, project)
          : table.kind === 'weld' ? resolvedWeldTable(table, response, project)
            : resolvedRevisionTable(table)),
    })),
  };
}
