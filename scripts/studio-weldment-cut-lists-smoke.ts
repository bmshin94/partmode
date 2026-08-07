import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHeadlessKernel, type HeadlessKernel } from '../src/headless/kernel-host.js';

type JsonRecord = Record<string, any>;

function check(label: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Weldment cut-list smoke failed: ${label}`);
}

function closeTo(actual: number, expected: number, tolerance = 2e-6): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function messageOf(error: unknown): string {
  return String((error as Error | null)?.message || error || '');
}

function expectFailure(label: string, action: () => unknown, pattern: RegExp): void {
  let failure: unknown = null;
  try { action(); } catch (error) { failure = error; }
  check(`${label} unexpectedly succeeded`, failure);
  check(`${label} returned the wrong refusal: ${messageOf(failure)}`, pattern.test(messageOf(failure)));
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const [runtime, agent, projectModule, drawingBook, drawingTables, drawingPdf, registry, structural] = await Promise.all([
  moduleAt('src/static/studio-v5-runtime-document.js'),
  moduleAt('src/static/studio-agent-service.js'),
  moduleAt('src/static/studio-project-v5.js'),
  moduleAt('src/static/studio-drawing-book.js'),
  moduleAt('src/static/studio-drawing-tables.js'),
  moduleAt('src/static/studio-drawing-pdf.js'),
  moduleAt('src/static/studio-v6-ui-registry.js'),
  moduleAt('src/static/studio-structural-members.js'),
]);

function blankProject(projectId: string): JsonRecord {
  return runtime.createStudioV5RuntimePartProject({
  projectId,
    name: 'Exact structural-member cut-list acceptance', units: 'mm', parameters: [], features: [],

}) as JsonRecord;
}

function transaction(project: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord {
  return agent.applyCadTransaction(project, {
    transactionId: id, label: id, expectedRevision: 0, atomic: true, operations,
  }) as JsonRecord;
}

function apply(project: JsonRecord, id: string, operations: JsonRecord[]): JsonRecord {
  return transaction(project, id, operations).project as JsonRecord;
}

function rootPart(project: JsonRecord): JsonRecord {
  return runtime.studioV5RootPart(project) as JsonRecord;
}

function jointProjectFromPaths(projectId: string, pathA: number[][], pathB: number[][]): JsonRecord {
  return apply(blankProject(projectId), 'create-structural-members', [
    {
      kind: 'sketch.path.create',
      input: { id: 'path-a', name: 'Member A path', curveKind: 'polyline', points: pathA },
    },
    {
      kind: 'sketch.path.create',
      input: { id: 'path-b', name: 'Member B path', curveKind: 'polyline', points: pathB },
    },
    {
      kind: 'structural.member.create',
      input: {
        id: 'member-a', name: 'Member <script>alert(1)</script>', pathSketchId: 'path-a',
        familyId: 'rectangular-bar', presetId: 'rect-20x10',
      },
    },
    {
      kind: 'structural.member.create',
      input: {
        id: 'member-b', name: 'Member B', pathSketchId: 'path-b',
        familyId: 'rectangular-bar', presetId: 'rect-20x10',
      },
    },
  ]);
}

function jointProject(projectId: string): JsonRecord {
  return jointProjectFromPaths(projectId, [[0, 0, 0], [100, 0, 0]], [[0, 0, 0], [0, 100, 0]]);
}

function withTreatment(project: JsonRecord, input: JsonRecord): JsonRecord {
  return apply(project, 'create-' + input.id, [{ kind: 'structural.treatment.create', input }]);
}

function withCutList(project: JsonRecord, name = 'Exact structural cut list'): JsonRecord {
  return apply(project, 'initialize-and-create-cut-list', [
    {
      kind: 'drawing.book.initialize',
      input: {
        title: 'Weldment cutting schedule', templateId: 'iso-a3-landscape', name: 'Cut list',
        scale: 'fit', views: ['front', 'top', 'right', 'iso'],
      },
    },
    {
      kind: 'drawing.table.create',
      input: {
        kind: 'cut-list', sheetId: 'sheet-000001', name, positionMm: [12, 12], widthMm: 240,
        sourceType: 'structural-member', sourceMemberIds: ['member-a', 'member-b'],
      },
    },
  ]);
}

function catalogCutListProject(): JsonRecord {
  const operations: JsonRecord[] = [];
  const memberIds: string[] = [];
  let index = 0;
  for (const family of structural.STUDIO_STRUCTURAL_PROFILE_FAMILIES as JsonRecord[]) {
    for (const preset of family.presets as JsonRecord[]) {
      const pathId = `catalog-path-${index}`;
      const memberId = `catalog-member-${index}`;
      const y = index * 60;
      operations.push({
        kind: 'sketch.path.create',
        input: { id: pathId, name: `${preset.designation} path`, curveKind: 'polyline', points: [[0, y, 0], [80, y, 0]] },
      });
      operations.push({
        kind: 'structural.member.create',
        input: {
          id: memberId, name: `${family.name} ${preset.designation}`, pathSketchId: pathId,
          familyId: family.id, presetId: preset.id,
        },
      });
      memberIds.push(memberId);
      index += 1;
    }
  }
  let project = apply(blankProject('weldment-cut-list-catalog'), 'create-full-profile-catalog', operations);
  project = apply(project, 'create-catalog-cut-list', [
    {
      kind: 'drawing.book.initialize',
      input: {
        title: 'Catalog cut matrix', templateId: 'iso-a3-landscape', name: 'Catalog',
        scale: 'fit', views: ['front', 'top', 'right', 'iso'],
      },
    },
    {
      kind: 'drawing.table.create',
      input: {
        kind: 'cut-list', sheetId: 'sheet-000001', name: 'Full structural catalog',
        positionMm: [12, 12], widthMm: 240, sourceType: 'structural-member', sourceMemberIds: memberIds,
      },
    },
  ]);
  return project;
}

async function exactDrawing(kernel: HeadlessKernel, project: JsonRecord, revision: number, label: string): Promise<JsonRecord> {
  const result = await kernel.request({
    kind: 'drawing-v5', requestId: `weldment-cut-list-${revision}-${label}`, projectId: project.projectId,
    revision, document: project, views: ['front', 'top', 'right', 'iso'],
  }, 180_000) as JsonRecord;
  check(`${label} exact drawing failed: ${JSON.stringify(result.errors || [])}`,
    result.kind === 'drawing-result' && result.errors?.length === 0
      && result.manifest?.exactProjectionEvidence?.kind === 'occt-hlr-exact'
      && result.manifest.exactProjectionEvidence.documentHash === runtime.studioV5CanonicalHash(project));
  const evidence = result.manifest?.structuralMemberCutEvidence;
  check(`${label} omitted current exact structural cut evidence: ${JSON.stringify(evidence)}`,
    evidence?.schema === 'partmode.structural-member-cut-evidence/v1'
      && evidence.kind === 'occt-exact-structural-member-cuts'
      && evidence.documentHash === runtime.studioV5CanonicalHash(project)
      && evidence.effectiveDocumentHash === result.manifest.exactProjectionEvidence.effectiveDocumentHash
      && evidence.lengthBasis === 'exact-brep-axial-envelope'
      && evidence.angleConvention === 'degrees-off-square'
      && evidence.errors.length === 0);
  return result;
}

function pdfResult(project: JsonRecord, response: JsonRecord): JsonRecord {
  return drawingPdf.createStudioDrawingBookPdf(
    response,
    project.name,
    drawingBook.inspectStudioDrawingBook(project),
    null,
    null,
    project.extensions.drawingTables,
    project,
  ) as JsonRecord;
}

function resolvedCutList(project: JsonRecord, response: JsonRecord): JsonRecord {
  const pdf = pdfResult(project, response);
  const tables = pdf.manifest?.pages?.[0]?.drawingTables?.tables || [];
  const table = tables.find((entry: JsonRecord) => entry.kind === 'cut-list' && entry.sourceType === 'structural-member');
  check('resolved PDF omitted the structural-member cut list', table);
  check('resolved structural cut-list headers drifted', JSON.stringify(table.headers) === JSON.stringify([
    'ITEM', 'MEMBER', 'PROFILE', 'MATERIAL', 'QTY', 'LENGTH mm', 'START ° OFF SQ', 'END ° OFF SQ',
  ]));
  check('resolved cut-list evidence is not exact and current',
    table.evidence?.kind === 'exact-structural-member-cuts'
      && table.evidence.documentHash === runtime.studioV5CanonicalHash(project)
      && table.evidence.lengthBasis === 'exact-brep-axial-envelope'
      && table.evidence.angleConvention === 'degrees-off-square');
  return { pdf, table };
}

function rowFor(table: JsonRecord, memberName: string): any[] {
  const row = table.rows.find((entry: any[]) => entry[1] === memberName);
  check(`resolved table omitted row ${memberName}: ${JSON.stringify(table.rows)}`, row);
  return row;
}

function assertRow(table: JsonRecord, memberName: string, lengthMm: number, start: number | 'COPE', end: number | 'COPE'): void {
  const row = rowFor(table, memberName);
  check(`${memberName} profile is not derived`, typeof row[2] === 'string' && row[2].length > 0);
  check(`${memberName} quantity is not the bounded explicit-member value`, row[4] === 1);
  check(`${memberName} length drifted: ${row[5]}`, closeTo(row[5], lengthMm));
  check(`${memberName} start cut drifted: ${row[6]}`, start === 'COPE' ? row[6] === 'COPE' : closeTo(row[6], start));
  check(`${memberName} end cut drifted: ${row[7]}`, end === 'COPE' ? row[7] === 'COPE' : closeTo(row[7], end));
}

check('drawing-table schema changed', drawingTables.STUDIO_DRAWING_TABLES_SCHEMA === 'partmode.drawing-tables/v1');
const cutControl = (registry.cadUiControlRegistry() as JsonRecord[]).find((entry) => entry.id === 'drawing.cut-list');
check('truthful semantic cut-list control is missing', cutControl?.adapter === 'available'
  && cutControl.adapterTool === 'cad_preview' && cutControl.completionTool === 'cad_commit'
  && JSON.stringify(cutControl.operationKinds) === JSON.stringify([
    'drawing.table.create', 'drawing.table.update', 'drawing.table.delete',
  ]));
const createCapability = (agent.cadCapabilityManifest().operations as JsonRecord[])
  .find((entry) => entry.kind === 'drawing.table.create');
check('typed drawing-table schema omits structural source fields',
  JSON.stringify(createCapability?.inputSchema || {}).includes('structural-member')
    && JSON.stringify(createCapability?.inputSchema || {}).includes('sourceMemberIds'));

const baselineSource = jointProject('weldment-cut-list-baseline');
const created = transaction(baselineSource, 'typed-create-cut-list', [
  {
    kind: 'drawing.book.initialize',
    input: {
      title: 'Weldment cutting schedule', templateId: 'iso-a3-landscape', name: 'Cut list',
      scale: 'fit', views: ['front', 'top', 'right', 'iso'],
    },
  },
  {
    kind: 'drawing.table.create',
    input: {
      kind: 'cut-list', sheetId: 'sheet-000001', name: 'Exact structural cut list',
      positionMm: [12, 12], widthMm: 240, sourceType: 'structural-member',
      sourceMemberIds: ['member-a', 'member-b'],
    },
  },
]);
let baseline = created.project as JsonRecord;
check('typed create omitted drawing-table change evidence',
  created.changeSet.created.some((entry: JsonRecord) => entry.kind === 'drawing-table'));
let graph = drawingTables.inspectStudioDrawingTables(baseline) as JsonRecord;
check('structural cut list did not persist only semantic source identities', graph.tables.length === 1
  && graph.tables[0].sourceType === 'structural-member'
  && JSON.stringify(graph.tables[0].sourceMemberIds) === JSON.stringify(['member-a', 'member-b'])
  && !Object.hasOwn(graph.tables[0], 'axis') && !Object.hasOwn(graph.tables[0], 'sourceBodyIds')
  && !Object.hasOwn(graph.tables[0], 'lengthMm') && !Object.hasOwn(graph.tables[0], 'angles'));
const tableId = graph.tables[0].id;
const saved = JSON.stringify(projectModule.prepareStudioV5Project(baseline));
const reopened = projectModule.parseStudioV5Project(saved) as JsonRecord;
check('structural cut list changed across canonical save/reopen', JSON.stringify(reopened) === saved
  && JSON.stringify(drawingTables.inspectStudioDrawingTables(reopened)) === JSON.stringify(graph));

baseline = apply(baseline, 'typed-update-cut-list', [{
  kind: 'drawing.table.update', input: { tableId, patch: { name: 'Updated exact structural cut list' } },
}]);
graph = drawingTables.inspectStudioDrawingTables(baseline);
check('typed update changed cut-list identity or sources', graph.tables[0].id === tableId
  && graph.tables[0].name === 'Updated exact structural cut list'
  && JSON.stringify(graph.tables[0].sourceMemberIds) === JSON.stringify(['member-a', 'member-b']));
expectFailure('source-type mutation', () => drawingTables.updateStudioDrawingTable(baseline, {
  tableId, patch: { sourceType: 'body-axis', axis: 'x', sourceBodyIds: ['body-member-a'] },
}), /sourceType cannot change|Delete and recreate/u);
expectFailure('authored derived axis in structural mode', () => drawingTables.createStudioDrawingTable(baseline, {
  kind: 'cut-list', sheetId: 'sheet-000001', name: 'Bad derived values', positionMm: [20, 20], widthMm: 200,
  sourceType: 'structural-member', sourceMemberIds: ['member-a'], axis: 'x',
}), /cannot persist axes|unsupported fields/u);
expectFailure('nonmember structural source', () => drawingTables.createStudioDrawingTable(baseline, {
  kind: 'cut-list', sheetId: 'sheet-000001', name: 'Bad member', positionMm: [20, 20], widthMm: 200,
  sourceType: 'structural-member', sourceMemberIds: ['path-a'],
}), /missing|non-root|structural member/u);

const trimBase = jointProject('weldment-cut-list-trim');
const trim = withCutList(withTreatment(trimBase, {
  id: 'treatment-trim', kind: 'trim-extend', name: 'Start trim', memberId: 'member-a', end: 'start', mode: 'trim', distance: 10,
}));
const extended = apply(trim, 'edit-trim-to-extend', [{
  kind: 'structural.treatment.update',
  input: { featureId: 'treatment-trim', patch: { mode: 'extend', distance: 5, name: 'Start extend' } },
}]);
const miter = withCutList(withTreatment(jointProject('weldment-cut-list-miter'), {
  id: 'treatment-miter', kind: 'corner', name: 'One-sided miter',
  targetMemberId: 'member-a', targetEnd: 'start', otherMemberId: 'member-b', otherEnd: 'start', style: 'miter',
}));
const reciprocalMiter = apply(miter, 'add-reciprocal-miter', [{
  kind: 'structural.treatment.create',
  input: {
    id: 'treatment-miter-reciprocal', kind: 'corner', name: 'Reciprocal miter',
    targetMemberId: 'member-b', targetEnd: 'start', otherMemberId: 'member-a', otherEnd: 'start', style: 'miter',
  },
}]);
const cope = withCutList(withTreatment(jointProject('weldment-cut-list-cope'), {
  id: 'treatment-cope', kind: 'corner', name: 'Exact cope',
  targetMemberId: 'member-a', targetEnd: 'start', otherMemberId: 'member-b', otherEnd: 'start', style: 'cope',
}));
const rotation = Math.PI / 6;
const rotated = withCutList(withTreatment(jointProjectFromPaths(
  'weldment-cut-list-rotated-miter',
  [[0, 0, 0], [100 * Math.cos(rotation), 100 * Math.sin(rotation), 0]],
  [[0, 0, 0], [-100 * Math.sin(rotation), 100 * Math.cos(rotation), 0]],
), {
  id: 'treatment-rotated-miter', kind: 'corner', name: 'Rotated miter',
  targetMemberId: 'member-a', targetEnd: 'start', otherMemberId: 'member-b', otherEnd: 'start', style: 'miter',
}));
const endMiter = withCutList(withTreatment(jointProjectFromPaths(
  'weldment-cut-list-end-miter',
  [[-100, 0, 0], [0, 0, 0]],
  [[0, 0, 0], [0, 100, 0]],
), {
  id: 'treatment-end-miter', kind: 'corner', name: 'End-target miter',
  targetMemberId: 'member-a', targetEnd: 'end', otherMemberId: 'member-b', otherEnd: 'start', style: 'miter',
}));
const pathEdited = apply(baseline, 'extend-member-path', [{
  kind: 'sketch.advanced.update',
  input: { sketchId: 'path-a', patch: { kind: 'polyline', points: [[0, 0, 0], [120, 0, 0]] } },
}]);
const catalog = catalogCutListProject();
const suppressed = apply(baseline, 'suppress-cut-list-member', [{
  kind: 'feature.suppress', input: { featureId: 'member-a', suppressed: true },
}]);
const suppressedRepaired = drawingTables.updateStudioDrawingTable(suppressed, {
  tableId, patch: { sourceMemberIds: ['member-b'] },
});
const rolledBack = apply(baseline, 'rollback-before-second-member', [{
  kind: 'feature.rollback', input: { featureId: 'member-a' },
}]);
const rollbackRepaired = drawingTables.updateStudioDrawingTable(rolledBack, {
  tableId, patch: { sourceMemberIds: ['member-a'] },
});
const configuredTable = drawingTables.updateStudioDrawingTable(baseline, {
  tableId, patch: { sourceMemberIds: ['member-a'] },
});
const configured = runtime.createStudioV5PartConfigurationSet(configuredTable, {
  partId: rootPart(configuredTable).id,
  activeConfigurationId: 'configuration-member-a',
  configurations: [
    {
      id: 'configuration-member-a', name: 'Member A only', parameterOverrides: {},
      featureSuppressionOverrides: { 'member-a': false, 'member-b': true },
    },
    {
      id: 'configuration-member-b', name: 'Member B only', parameterOverrides: {},
      featureSuppressionOverrides: { 'member-a': true, 'member-b': false },
    },
  ],
}).project as JsonRecord;
expectFailure('active-configuration suppressed source create', () => drawingTables.createStudioDrawingTable(configured, {
  kind: 'cut-list', sheetId: 'sheet-000001', name: 'Suppressed configured member',
  positionMm: [12, 150], widthMm: 240, sourceType: 'structural-member', sourceMemberIds: ['member-b'],
}), /missing|suppressed|configuration/u);

let kernel: HeadlessKernel | null = null;
let freshKernel: HeadlessKernel | null = null;
let revision = 0;
let baselineDrawing: JsonRecord;
let baselineResolved: JsonRecord;
let pathDrawing: JsonRecord;
let pathResolved: JsonRecord;
let miterDrawing: JsonRecord;
let miterResolved: JsonRecord;
let configuredDrawing: JsonRecord;
try {
  kernel = await createHeadlessKernel();
  await kernel.waitForKernel();

  baselineDrawing = await exactDrawing(kernel, baseline, ++revision, 'baseline');
  baselineResolved = resolvedCutList(baseline, baselineDrawing);
  assertRow(baselineResolved.table, 'Member <script>alert(1)</script>', 100, 0, 0);
  assertRow(baselineResolved.table, 'Member B', 100, 0, 0);

  const trimDrawing = await exactDrawing(kernel, trim, ++revision, 'trim');
  const trimResolved = resolvedCutList(trim, trimDrawing);
  assertRow(trimResolved.table, 'Member <script>alert(1)</script>', 90, 0, 0);
  check('trim evidence omitted treatment association',
    trimResolved.table.evidence.members.find((entry: JsonRecord) => entry.memberId === 'member-a')?.start?.treatmentFeatureId === 'treatment-trim');

  const extendDrawing = await exactDrawing(kernel, extended, ++revision, 'extend');
  const extendResolved = resolvedCutList(extended, extendDrawing);
  assertRow(extendResolved.table, 'Member <script>alert(1)</script>', 105, 0, 0);
  check('trim-to-extend edit replaced table identity',
    drawingTables.inspectStudioDrawingTables(extended).tables[0].id === drawingTables.inspectStudioDrawingTables(trim).tables[0].id);

  miterDrawing = await exactDrawing(kernel, miter, ++revision, 'miter');
  miterResolved = resolvedCutList(miter, miterDrawing);
  assertRow(miterResolved.table, 'Member <script>alert(1)</script>', 100, 45, 0);
  assertRow(miterResolved.table, 'Member B', 100, 0, 0);

  const reciprocalDrawing = await exactDrawing(kernel, reciprocalMiter, ++revision, 'reciprocal-miter');
  const reciprocalResolved = resolvedCutList(reciprocalMiter, reciprocalDrawing);
  assertRow(reciprocalResolved.table, 'Member <script>alert(1)</script>', 100, 45, 0);
  assertRow(reciprocalResolved.table, 'Member B', 100, 45, 0);

  const copeDrawing = await exactDrawing(kernel, cope, ++revision, 'cope');
  const copeResolved = resolvedCutList(cope, copeDrawing);
  assertRow(copeResolved.table, 'Member <script>alert(1)</script>', 100, 'COPE', 0);
  const copeEvidence = copeResolved.table.evidence.members.find((entry: JsonRecord) => entry.memberId === 'member-a');
  check('cope evidence invented a numeric cut angle', copeEvidence?.start?.kind === 'cope'
    && copeEvidence.start.angleOffSquareDeg === null && copeEvidence.start.faceNames.length > 0);

  const rotatedDrawing = await exactDrawing(kernel, rotated, ++revision, 'rotated-miter');
  const rotatedResolved = resolvedCutList(rotated, rotatedDrawing);
  assertRow(rotatedResolved.table, 'Member <script>alert(1)</script>', 100, 45, 0);

  const endMiterDrawing = await exactDrawing(kernel, endMiter, ++revision, 'end-target-miter');
  const endMiterResolved = resolvedCutList(endMiter, endMiterDrawing);
  assertRow(endMiterResolved.table, 'Member <script>alert(1)</script>', 100, 0, 45);

  const suppressedDrawing = await exactDrawing(kernel, suppressed, ++revision, 'suppressed-source');
  expectFailure('suppressed structural source resolved', () => resolvedCutList(suppressed, suppressedDrawing),
    /missing|suppressed|exact cut evidence/u);
  const suppressionRepairDrawing = await exactDrawing(kernel, suppressedRepaired, ++revision, 'suppressed-source-repair');
  const suppressionRepairResolved = resolvedCutList(suppressedRepaired, suppressionRepairDrawing);
  check('suppressed-reference repair did not retain only the active member',
    suppressionRepairResolved.table.rows.length === 1 && suppressionRepairResolved.table.rows[0][1] === 'Member B');

  const rollbackDrawing = await exactDrawing(kernel, rolledBack, ++revision, 'rollback-excluded-source');
  expectFailure('rollback-excluded structural source resolved', () => resolvedCutList(rolledBack, rollbackDrawing),
    /rollback|missing|exact cut evidence/u);
  const rollbackRepairDrawing = await exactDrawing(kernel, rollbackRepaired, ++revision, 'rollback-source-repair');
  const rollbackRepairResolved = resolvedCutList(rollbackRepaired, rollbackRepairDrawing);
  check('rollback-reference repair did not retain only the active member',
    rollbackRepairResolved.table.rows.length === 1
      && rollbackRepairResolved.table.rows[0][1] === 'Member <script>alert(1)</script>');

  configuredDrawing = await exactDrawing(kernel, configured, ++revision, 'active-part-configuration');
  const configuredResolved = resolvedCutList(configured, configuredDrawing);
  assertRow(configuredResolved.table, 'Member <script>alert(1)</script>', 100, 0, 0);
  check('configured cut evidence did not bind a distinct effective document hash',
    configuredDrawing.manifest.structuralMemberCutEvidence.effectiveDocumentHash
      !== configuredDrawing.manifest.structuralMemberCutEvidence.documentHash);

  pathDrawing = await exactDrawing(kernel, pathEdited, ++revision, 'path-edit');
  pathResolved = resolvedCutList(pathEdited, pathDrawing);
  assertRow(pathResolved.table, 'Member <script>alert(1)</script>', 120, 0, 0);
  check('associative Path edit replaced persistent table identity',
    drawingTables.inspectStudioDrawingTables(pathEdited).tables[0].id === tableId);

  const catalogDrawing = await exactDrawing(kernel, catalog, ++revision, 'full-profile-catalog');
  const catalogBook = drawingBook.inspectStudioDrawingBook(catalog);
  const catalogResolved = drawingTables.resolveStudioDrawingSheetTables(
    catalogBook, catalog.extensions.drawingTables, catalogBook.sheets[0].id, catalogDrawing, catalog,
  );
  const catalogTable = catalogResolved.tables[0];
  check('full structural catalog did not resolve one exact row per shipped preset',
    catalogTable.rows.length === 15 && catalogTable.evidence.members.length === 15);
  for (const row of catalogTable.rows) {
    check(`catalog row drifted: ${JSON.stringify(row)}`,
      row[4] === 1 && closeTo(row[5], 80) && closeTo(row[6], 0) && closeTo(row[7], 0));
  }

  await kernel.dispose();
  kernel = null;
  freshKernel = await createHeadlessKernel();
  await freshKernel.waitForKernel();
  const freshMiter = await exactDrawing(freshKernel, miter, 1, 'fresh-worker-miter');
  check('fresh worker changed exact structural cut evidence',
    JSON.stringify(freshMiter.manifest.structuralMemberCutEvidence)
      === JSON.stringify(miterDrawing.manifest.structuralMemberCutEvidence));
} finally {
  await kernel?.dispose();
  await freshKernel?.dispose();
}

check('structural cut-list PDF is not deterministic',
  Buffer.compare(Buffer.from(miterResolved!.pdf.bytes), Buffer.from(pdfResult(miter, miterDrawing!).bytes)) === 0);
check('associative Path edit did not change the PDF artifact',
  Buffer.compare(Buffer.from(baselineResolved!.pdf.bytes), Buffer.from(pathResolved!.pdf.bytes)) !== 0);
const artifactDirectory = await mkdtemp(join(tmpdir(), 'partmode-weldment-cut-list-'));
try {
  const pdfPath = join(artifactDirectory, 'structural-cut-list.pdf');
  await writeFile(pdfPath, Buffer.from(miterResolved!.pdf.bytes));
  const info = spawnSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
  check(`independent pdfinfo validation failed: ${info.stderr || info.stdout}`,
    info.status === 0 && /^Pages:\s+1$/mu.test(info.stdout) && /^PDF version:\s+\d/mu.test(info.stdout));
  const extracted = spawnSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
  if (extracted.status === 0) {
    check(`independent PDF text omitted structural cut-list content: ${JSON.stringify(extracted.stdout)}`,
      extracted.stdout.includes('Member <script>alert')
        && extracted.stdout.includes('START') && extracted.stdout.includes('45'));
  }
} finally {
  await rm(artifactDirectory, { recursive: true, force: true });
}

const book = drawingBook.inspectStudioDrawingBook(miter);
const resolveTampered = (label: string, mutate: (candidate: JsonRecord) => void, pattern: RegExp): void => {
  const candidate = structuredClone(miterDrawing!);
  mutate(candidate);
  expectFailure(label, () => drawingTables.resolveStudioDrawingSheetTables(
    book, miter.extensions.drawingTables, book.sheets[0].id, candidate, miter,
  ), pattern);
};
resolveTampered('tampered exact length', (candidate) => {
  candidate.manifest.structuralMemberCutEvidence.members[0].lengthMm += 1;
}, /axial envelope|length/u);
resolveTampered('tampered valid-looking B-rep digest', (candidate) => {
  candidate.manifest.structuralMemberCutEvidence.members[0].brepSha256 = '0'.repeat(64);
}, /B-rep|detached|cross-check/u);
resolveTampered('incomplete exact topology', (candidate) => {
  candidate.manifest.structuralMemberCutEvidence.members[0].topology.faces.pop();
}, /topology|fingerprint|coverage/u);
resolveTampered('tampered exact face normal', (candidate) => {
  candidate.manifest.structuralMemberCutEvidence.members[0].topology.faces[0].normal = [2, 0, 0];
}, /topology fingerprint|face normal|treatment plane/u);
resolveTampered('duplicate structural member evidence', (candidate) => {
  candidate.manifest.structuralMemberCutEvidence.members.push(
    structuredClone(candidate.manifest.structuralMemberCutEvidence.members[0]),
  );
}, /duplicate member identities|duplicate/u);
resolveTampered('ambiguous exact body evidence', (candidate) => {
  const bodyId = candidate.manifest.structuralMemberCutEvidence.members[0].bodyId;
  candidate.bodies.push(structuredClone(candidate.bodies.find((entry: JsonRecord) => entry.bodyId === bodyId)));
}, /exactly one current exact body|matchCount|one current/u);
const tamperedConfigurationHash = structuredClone(configuredDrawing!);
tamperedConfigurationHash.manifest.structuralMemberCutEvidence.effectiveDocumentHash = '0'.repeat(64);
tamperedConfigurationHash.manifest.exactProjectionEvidence.effectiveDocumentHash = '0'.repeat(64);
expectFailure('self-consistent forged active-configuration hash', () => drawingTables.resolveStudioDrawingSheetTables(
  drawingBook.inspectStudioDrawingBook(configured), configured.extensions.drawingTables, 'sheet-000001',
  tamperedConfigurationHash, configured,
), /configuration|effective|hash-bound|current/u);

expectFailure('stale exact document', () => drawingTables.resolveStudioDrawingSheetTables(
  drawingBook.inspectStudioDrawingBook(pathEdited), pathEdited.extensions.drawingTables, 'sheet-000001',
  baselineDrawing!, pathEdited,
), /current document|stale/u);

const stale = structuredClone(baseline);
stale.extensions.drawingTables.tables[0].sourceMemberIds = ['member-missing'];
check('structurally valid stale table is not inspectable',
  drawingTables.inspectStudioDrawingTables(stale).tables[0].sourceMemberIds[0] === 'member-missing');
const repaired = drawingTables.updateStudioDrawingTable(stale, {
  tableId, patch: { sourceMemberIds: ['member-a'] },
});
check('stale table could not be repaired without replacing identity',
  drawingTables.inspectStudioDrawingTables(repaired).tables[0].id === tableId
    && JSON.stringify(drawingTables.inspectStudioDrawingTables(repaired).tables[0].sourceMemberIds) === JSON.stringify(['member-a']));
const deletedStale = drawingTables.deleteStudioDrawingTable(stale, tableId);
check('stale table could not be deleted', drawingTables.inspectStudioDrawingTables(deletedStale).tables.length === 0);

expectFailure('delete referenced member', () => apply(baseline, 'delete-referenced-member', [{
  kind: 'feature.delete', input: { featureId: 'member-a' },
}]), /drawing cut-list tables|Delete or repair/u);
expectFailure('delete referenced member body', () => runtime.deleteStudioV5Body(baseline, 'body-member-a'),
  /drawing cut-list tables|Delete or repair/u);
const withoutTable = apply(baseline, 'delete-cut-list-first', [{
  kind: 'drawing.table.delete', input: { tableId },
}]);
const withoutMember = apply(withoutTable, 'delete-member-after-table', [{
  kind: 'feature.delete', input: { featureId: 'member-a' },
}]);
check('member deletion remained blocked after cut-list deletion',
  !rootPart(withoutMember).features.some((entry: JsonRecord) => entry.id === 'member-a')
    && !rootPart(withoutMember).bodies.some((entry: JsonRecord) => entry.id === 'body-member-a'));

console.log(JSON.stringify({
  schema: 'partmode.weldment-cut-lists-smoke/v1',
  capability: 'persistent exact structural-member cut lists with long-point lengths and end cuts',
  sourceType: 'structural-member',
  exactProductionWorkerEvaluations: 16,
  exactCases: [
    'square', 'trim', 'extend', 'start miter', 'end miter', 'reciprocal-miter', 'rotated-miter', 'cope', 'Path edit',
    'all 15 shipped structural profile presets',
    'active part configuration',
  ],
  lengthBasis: 'exact-brep-axial-envelope',
  angleConvention: 'degrees-off-square',
  copeAngle: null,
  typedLifecycle: ['create', 'update', 'delete'],
  repairLifecycle: [
    'inspect-stale', 'repair-stale', 'delete-stale', 'suppressed-source repair', 'rollback-excluded-source repair',
  ],
  deterministicPdf: true,
  independentPdfinfo: true,
  freshWorkerDeterminism: true,
  failClosed: [
    'source-type mutation', 'derived-value authoring', 'nonmember source', 'suppressed source',
    'rollback-excluded source', 'member/body deletion',
    'stale document', 'forged effective configuration hash', 'tampered length', 'tampered B-rep digest',
    'incomplete topology', 'tampered face normal', 'duplicate member evidence', 'ambiguous body evidence',
  ],
  unsupported: [
    'automatic grouping', 'patterns and assembly rollups', 'multi-segment and curved members',
    'stock nesting and cut optimization', 'signed 3D cut rotation', 'manufacturing certification',
  ],
}, null, 2));
