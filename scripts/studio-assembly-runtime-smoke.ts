import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonDocument = Record<string, any>;

interface RebuildBodySummary {
  bodyId: string;
  sourceBodyId: string;
  occurrenceId: string | null;
  occurrencePath: string[];
  renderSourceBodyId: string | null;
  sharesSourceGeometry: boolean;
  renderTransform: number[] | null;
  geometry: Record<string, any> | null;
  mesh: Record<string, any> | null;
  error: Record<string, any> | null;
  lastValid: boolean;
}

interface RebuildSummary {
  id: string;
  kind: string;
  errors: Array<Record<string, any>>;
  warnings: Array<Record<string, any>>;
  evaluation: Record<string, any>;
  bodies: RebuildBodySummary[];
}

interface DrawingSummary {
  id: string;
  kind: string;
  errors: Array<Record<string, any>>;
  views: Array<{
    view: string;
    visibleCount: number;
    hiddenCount: number;
    viewBox: number[];
  }> | null;
  manifest: Record<string, any> | null;
}

interface MeshExportSummary {
  size: number;
  type: string;
  errors: Array<Record<string, any>>;
  manifest: Record<string, any> | null;
  text: string;
  bytes: number[];
}

interface ParsedExchangeMesh {
  name: string;
  vertices: number[];
  triangles: number[];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, '..', '..');
const fixturePath = resolve(root, 'tests', 'assembly-runtime', 'two-part-constrained.partmode.json');

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function quantized(values: number[], precision = 1e8): number[] {
  return values.map((value) => Math.round(value * precision) / precision);
}

function sameNumbers(actual: number[], expected: number[], label: string, tolerance = 1e-7): void {
  invariant(actual.length === expected.length, `${label}: expected ${expected.length} values, received ${actual.length}`);
  actual.forEach((value, index) => invariant(
    Math.abs(value - expected[index]!) <= tolerance,
    `${label}[${index}]: expected ${expected[index]}, received ${value}`,
  ));
}

function sameMatrix(actual: number[][], expected: number[][], label: string, tolerance = 1e-7): void {
  invariant(actual.length === 3 && actual.every((row) => row.length === 3), `${label}: expected a 3 by 3 tensor`);
  for (let row = 0; row < 3; row++) sameNumbers(actual[row]!, expected[row]!, `${label}[${row}]`, tolerance);
}

function addMatrices(left: number[][], right: number[][]): number[][] {
  return left.map((row, rowIndex) => row.map((value, columnIndex) => value + right[rowIndex]![columnIndex]!));
}

function boxInertia(mass: number, dimensions: [number, number, number]): number[][] {
  const [x, y, z] = dimensions;
  return [
    [mass * (y * y + z * z) / 12, 0, 0],
    [0, mass * (x * x + z * z) / 12, 0],
    [0, 0, mass * (x * x + y * y) / 12],
  ];
}

function shiftedInertia(tensor: number[][], mass: number, source: number[], target: number[]): number[][] {
  const delta = source.map((value, axis) => value - target[axis]!);
  const distanceSquared = delta.reduce((total, value) => total + value * value, 0);
  return tensor.map((row, rowIndex) => row.map((value, columnIndex) => value + mass * (
    (rowIndex === columnIndex ? distanceSquared : 0) - delta[rowIndex]! * delta[columnIndex]!
  )));
}

function testCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZipEntries(source: number[]): Map<string, Uint8Array> {
  const bytes = Uint8Array.from(source);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    invariant(view.getUint16(offset + 8, true) === 0, '3MF ZIP entry is not stored deterministically');
    const checksum = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    invariant(compressedSize === size, '3MF stored ZIP entry size differs from its uncompressed size');
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const data = bytes.slice(dataStart, dataStart + size);
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    invariant(testCrc32(data) === checksum, `3MF ZIP CRC mismatch for ${name}`);
    invariant(!entries.has(name), `3MF ZIP repeats entry ${name}`);
    entries.set(name, data);
    offset = dataStart + size;
  }
  invariant(view.getUint32(offset, true) === 0x02014b50, '3MF ZIP central directory is missing');
  return entries;
}

function xmlText(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function parseAmfMeshes(xml: string): ParsedExchangeMesh[] {
  return [...xml.matchAll(/<object id="\d+">([\s\S]*?)<\/object>/g)].map((match) => {
    const body = match[1]!;
    const name = /<metadata type="name">([\s\S]*?)<\/metadata>/.exec(body)?.[1];
    const vertices = [...body.matchAll(/<vertex><coordinates><x>([^<]+)<\/x><y>([^<]+)<\/y><z>([^<]+)<\/z><\/coordinates><\/vertex>/g)]
      .flatMap((entry) => [Number(entry[1]), Number(entry[2]), Number(entry[3])]);
    const triangles = [...body.matchAll(/<triangle><v1>(\d+)<\/v1><v2>(\d+)<\/v2><v3>(\d+)<\/v3><\/triangle>/g)]
      .flatMap((entry) => [Number(entry[1]), Number(entry[2]), Number(entry[3])]);
    invariant(name && vertices.length && triangles.length, 'AMF object is missing its name or mesh data');
    return { name: xmlText(name), vertices, triangles };
  });
}

function parseThreeMfMeshes(xml: string): ParsedExchangeMesh[] {
  return [...xml.matchAll(/<object id="\d+" type="model" name="([^"]*)">([\s\S]*?)<\/object>/g)].map((match) => {
    const body = match[2]!;
    const vertices = [...body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)]
      .flatMap((entry) => [Number(entry[1]), Number(entry[2]), Number(entry[3])]);
    const triangles = [...body.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)]
      .flatMap((entry) => [Number(entry[1]), Number(entry[2]), Number(entry[3])]);
    invariant(vertices.length && triangles.length, '3MF object is missing mesh data');
    return { name: xmlText(match[1]!), vertices, triangles };
  });
}

function meshBounds(vertices: number[]): number[][] {
  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertices.length; index += 3) for (let axis = 0; axis < 3; axis++) {
    lower[axis] = Math.min(lower[axis]!, vertices[index + axis]!);
    upper[axis] = Math.max(upper[axis]!, vertices[index + axis]!);
  }
  return [lower, upper];
}

function meshVolume(mesh: ParsedExchangeMesh): number {
  let volume = 0;
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const points = [mesh.triangles[index]!, mesh.triangles[index + 1]!, mesh.triangles[index + 2]!].map((vertex) => [
      mesh.vertices[vertex * 3]!, mesh.vertices[vertex * 3 + 1]!, mesh.vertices[vertex * 3 + 2]!,
    ]);
    const [a, b, c] = points;
    volume += a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!)
      - a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!)
      + a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!);
  }
  return Math.abs(volume / 6);
}

function assertExchangeMeshes(meshes: ParsedExchangeMesh[], expectedNames: string[]): void {
  invariant(meshes.length === 2, `exchange export contains ${meshes.length} mesh objects`);
  invariant(JSON.stringify(meshes.map((entry) => entry.name)) === JSON.stringify(expectedNames),
    `exchange export names are wrong ${JSON.stringify(meshes.map((entry) => entry.name))}`);
  const expectedBounds = [[[-10, -5, 0], [10, 5, 8]], [[10, -5, 0], [22, 3, 14]]];
  const expectedVolumes = [1600, 1344];
  meshes.forEach((mesh, meshIndex) => {
    invariant(mesh.vertices.length % 3 === 0 && mesh.triangles.length % 3 === 0,
      `exchange mesh ${meshIndex} has malformed arrays`);
    const vertexCount = mesh.vertices.length / 3;
    invariant(mesh.triangles.every((entry) => Number.isInteger(entry) && entry >= 0 && entry < vertexCount),
      `exchange mesh ${meshIndex} has an out-of-range triangle index`);
    sameNumbers(meshBounds(mesh.vertices).flat(), expectedBounds[meshIndex]!.flat(),
      `exchange mesh ${meshIndex} bounds`, 2e-6);
    invariant(Math.abs(meshVolume(mesh) - expectedVolumes[meshIndex]!) <= 2e-5,
      `exchange mesh ${meshIndex} volume is ${meshVolume(mesh)}`);
  });
}

function body(result: RebuildSummary, occurrenceId: string): RebuildBodySummary {
  const matches = result.bodies.filter((entry) => entry.occurrenceId === occurrenceId);
  invariant(matches.length === 1, `${result.id}: occurrence ${occurrenceId} resolved to ${matches.length} bodies`);
  return matches[0]!;
}

function assertExactBody(result: RebuildSummary, occurrenceId: string, requireSerializedMesh = false): RebuildBodySummary {
  const entry = body(result, occurrenceId);
  invariant(!entry.error, `${result.id}/${occurrenceId}: body error ${JSON.stringify(entry.error)}`);
  invariant(!entry.lastValid, `${result.id}/${occurrenceId}: body used last-valid geometry`);
  invariant(entry.geometry?.valid === true, `${result.id}/${occurrenceId}: exact shape is invalid`);
  invariant(entry.geometry?.brepValid === true, `${result.id}/${occurrenceId}: B-rep analyzer rejected exact shape`);
  invariant(entry.geometry?.solidCount === 1, `${result.id}/${occurrenceId}: expected one exact solid`);
  invariant(Number(entry.geometry?.volume) > 1e-8, `${result.id}/${occurrenceId}: exact volume is not positive`);
  invariant(entry.renderTransform?.length === 16, `${result.id}/${occurrenceId}: solved render transform is missing`);
  if (requireSerializedMesh) invariant(entry.mesh !== null, `${result.id}/${occurrenceId}: exact OCCT body serialization is missing`);
  if (entry.mesh) {
    invariant(Number(entry.mesh.faces) > 0 && Number(entry.mesh.edges) > 0 && Number(entry.mesh.vertices) > 0,
      `${result.id}/${occurrenceId}: exact OCCT topology is empty`);
    invariant((entry.mesh.diagnostics || []).length === 0,
      `${result.id}/${occurrenceId}: exact topology diagnostics ${JSON.stringify(entry.mesh.diagnostics)}`);
  }
  return entry;
}

function assertSolved(result: RebuildSummary, requireSerializedMesh = false): void {
  invariant(result.kind === 'rebuild-result', `${result.id}: expected rebuild-result, received ${result.kind}`);
  invariant(result.errors.length === 0, `${result.id}: assembly errors ${JSON.stringify(result.errors)}`);
  invariant(result.warnings.length === 0, `${result.id}: assembly warnings ${JSON.stringify(result.warnings)}`);
  invariant(result.evaluation.solverState === 'fully-constrained',
    `${result.id}: solver state is ${String(result.evaluation.solverState)}`);
  invariant(result.evaluation.solverRank === 6,
    `${result.id}: expected solver rank 6, received ${String(result.evaluation.solverRank)}`);
  invariant(result.evaluation.degreesOfFreedom?.['occurrence-base'] === 0,
    `${result.id}: fixed occurrence DOF is not zero`);
  invariant(result.evaluation.degreesOfFreedom?.['occurrence-moving'] === 0,
    `${result.id}: moving occurrence DOF is not zero`);
  invariant(Array.isArray(result.evaluation.solverComponents) && result.evaluation.solverComponents.length === 1,
    `${result.id}: solver component diagnostics are missing`);
  const component = result.evaluation.solverComponents[0];
  invariant(component.rank === 6 && component.degreesOfFreedom === 0 && component.state === 'fully-constrained',
    `${result.id}: component rank/nullity is wrong ${JSON.stringify(component)}`);
  invariant(Array.isArray(result.evaluation.solverDiagnostics), `${result.id}: solver diagnostics channel is missing`);
  invariant(result.evaluation.usedLastValid === false, `${result.id}: solver used a last-valid placement`);
  assertExactBody(result, 'occurrence-base', requireSerializedMesh);
  const moving = assertExactBody(result, 'occurrence-moving', requireSerializedMesh);
  sameNumbers(moving.renderTransform!, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 16, 0, 1, 1],
    `${result.id}: solved scene placement`, 2e-6);
}

function stableRebuildEvidence(result: RebuildSummary): Record<string, any> {
  return {
    solverState: result.evaluation.solverState,
    solverRank: result.evaluation.solverRank,
    degreesOfFreedom: result.evaluation.degreesOfFreedom,
    components: result.evaluation.solverComponents,
    bodies: result.bodies.map((entry) => ({
      occurrenceId: entry.occurrenceId,
      sourceBodyId: entry.sourceBodyId,
      renderTransform: quantized(entry.renderTransform || []),
      bounds: (entry.geometry?.bounds || []).map((axis: number[]) => quantized(axis)),
      volume: Math.round(Number(entry.geometry?.volume) * 1e8) / 1e8,
      solidCount: entry.geometry?.solidCount,
    })).sort((left, right) => String(left.occurrenceId).localeCompare(String(right.occurrenceId))),
  };
}

function drawingBalloons(manifest: Record<string, any>): Array<Record<string, any>> {
  if (Array.isArray(manifest.annotations?.balloons)) return manifest.annotations.balloons;
  if (Array.isArray(manifest.balloons)) return manifest.balloons;
  return [];
}

function exactDrawingEvidence(manifest: Record<string, any>): Record<string, any> | null {
  return manifest.exactProjectionEvidence || manifest.drawingPlan?.exactProjectionEvidence || null;
}

function assertAssemblyDrawing(result: DrawingSummary): void {
  invariant(result.kind === 'drawing-result', `${result.id}: expected drawing-result, received ${result.kind}`);
  invariant(result.errors.length === 0, `${result.id}: drawing errors ${JSON.stringify(result.errors)}`);
  invariant(Array.isArray(result.views) && result.views.length >= 3,
    `${result.id}: exact assembly HLR returned ${result.views?.length ?? 0} views`);
  for (const view of result.views) {
    invariant(view.visibleCount > 0, `${result.id}/${view.view}: exact HLR has no visible paths`);
    invariant(view.viewBox.length === 4 && view.viewBox.every(Number.isFinite),
      `${result.id}/${view.view}: exact HLR view box is invalid`);
  }
  const manifest = result.manifest;
  invariant(manifest, `${result.id}: assembly drawing manifest is missing`);
  invariant(Array.isArray(manifest.bom) && manifest.bom.length === 2,
    `${result.id}: expected two deterministic BOM rows, received ${manifest.bom?.length ?? 0}`);
  invariant(JSON.stringify(manifest.bom.map((entry: Record<string, any>) => entry.partNumber)) ===
    JSON.stringify(['PM-BASE-100', 'PM-MOVING-200']),
  `${result.id}: BOM part ordering is not deterministic ${JSON.stringify(manifest.bom)}`);
  invariant(JSON.stringify(manifest.bom.map((entry: Record<string, any>) => entry.itemNumber)) === JSON.stringify([1, 2]),
    `${result.id}: BOM item numbering is wrong`);
  invariant(manifest.bom.every((entry: Record<string, any>) => entry.quantity === 1),
    `${result.id}: BOM quantities are wrong`);
  const balloons = drawingBalloons(manifest);
  invariant(balloons.length === 2, `${result.id}: expected two exact-projection balloons, received ${balloons.length}`);
  invariant(JSON.stringify(balloons.map((entry) => entry.itemNumber).sort()) === JSON.stringify([1, 2]),
    `${result.id}: balloon item mapping is wrong`);
  invariant(balloons.every((entry) => entry.evidence?.kind === 'occt-brep-camera-support'
    && entry.evidence.assemblyProjectionKind === 'occt-hlr-exact'
    && entry.evidence.revisionKey === manifest.drawingPlan?.revisionKey
    && typeof entry.evidence.supportFingerprint === 'string' && entry.evidence.supportFingerprint.length === 32),
  `${result.id}: balloon evidence is not current exact B-rep camera support bound to assembly HLR`);
  invariant(exactDrawingEvidence(manifest)?.kind === 'occt-hlr-exact',
    `${result.id}: exact projection evidence marker is missing`);
}

async function runRebuildSequence(
  page: Page,
  sequenceId: string,
  variants: Array<{ id: string; document: JsonDocument }>,
): Promise<RebuildSummary[]> {
  return page.evaluate(async (input) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    const worker = new Worker(workerUrl, { type: 'module' });
    let revision = 0;
    try {
      const summaries = [];
      for (const variant of input.variants) {
        revision += 1;
        const requestId = `${input.sequenceId}-${revision}`;
        const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
          const timeout = setTimeout(() => rejectResponse(new Error(`${variant.id}: assembly rebuild timed out`)), 120_000);
          const onMessage = (event: MessageEvent<Record<string, any>>) => {
            const data = event.data;
            if (data?.kind === 'kernel-status' && data.status === 'failed') {
              clearTimeout(timeout);
              worker.removeEventListener('message', onMessage);
              rejectResponse(new Error(data.message || 'CAD kernel initialization failed'));
              return;
            }
            if (data?.requestId !== requestId) return;
            clearTimeout(timeout);
            worker.removeEventListener('message', onMessage);
            if (data.kind === 'kernel-error') rejectResponse(new Error(data.message || 'CAD kernel error'));
            else resolveResponse(data);
          };
          worker.addEventListener('message', onMessage);
          worker.postMessage({
            kind: 'rebuild',
            requestId,
            projectId: variant.document.projectId,
            revision,
            document: variant.document,
          });
        });
        summaries.push({
          id: variant.id,
          kind: String(response.kind || ''),
          errors: (response.errors || []).map((entry: Record<string, any>) => ({
            mateId: entry.mateId,
            featureType: entry.featureType,
            message: entry.message,
            conflictSet: entry.conflictSet,
          })),
          warnings: (response.warnings || []).map((entry: Record<string, any>) => ({
            code: entry.code,
            message: entry.message,
          })),
          evaluation: JSON.parse(JSON.stringify(response.evaluation || {})),
          bodies: (response.bodies || []).map((entry: Record<string, any>) => ({
            bodyId: String(entry.bodyId || ''),
            sourceBodyId: String(entry.sourceBodyId || ''),
            occurrenceId: typeof entry.occurrenceInstance?.occurrenceId === 'string'
              ? entry.occurrenceInstance.occurrenceId
              : null,
            occurrencePath: [...(entry.occurrenceInstance?.occurrencePath || [])],
            renderSourceBodyId: typeof entry.renderSourceBodyId === 'string' ? entry.renderSourceBodyId : null,
            sharesSourceGeometry: entry.sharesSourceGeometry === true,
            renderTransform: Array.isArray(entry.renderTransform) ? [...entry.renderTransform] : null,
            geometry: entry.geometry ? JSON.parse(JSON.stringify(entry.geometry)) : null,
            mesh: entry.mesh ? {
              faces: Number(entry.mesh.topologyCounts?.faces ?? entry.mesh.topologyFaces?.length ?? 0),
              edges: Number(entry.mesh.topologyCounts?.edges ?? entry.mesh.edges?.length ?? 0),
              vertices: Number(entry.mesh.topologyCounts?.vertices ?? entry.mesh.topologyVertices?.length ?? 0),
              diagnostics: (entry.mesh.topologyDiagnostics || []).map((diagnostic: Record<string, any>) => ({
                code: diagnostic.code,
                reason: diagnostic.reason,
                severity: diagnostic.severity,
              })),
            } : null,
            error: entry.error ? JSON.parse(JSON.stringify(entry.error)) : null,
            lastValid: entry.lastValid === true,
          })),
        });
      }
      return summaries;
    } finally {
      worker.terminate();
    }
  }, { sequenceId, variants }) as Promise<RebuildSummary[]>;
}

async function runDrawing(
  page: Page,
  id: string,
  documentValue: JsonDocument,
): Promise<DrawingSummary> {
  return page.evaluate(async (input) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    const worker = new Worker(workerUrl, { type: 'module' });
    try {
      const requestId = `assembly-drawing-${input.id}`;
      const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(() => rejectResponse(new Error(`${input.id}: assembly drawing timed out`)), 180_000);
        const onMessage = (event: MessageEvent<Record<string, any>>) => {
          const data = event.data;
          if (data?.kind === 'kernel-status' && data.status === 'failed') {
            clearTimeout(timeout);
            worker.removeEventListener('message', onMessage);
            rejectResponse(new Error(data.message || 'CAD kernel initialization failed'));
            return;
          }
          if (data?.requestId !== requestId) return;
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          if (data.kind === 'kernel-error') rejectResponse(new Error(data.message || 'CAD kernel error'));
          else resolveResponse(data);
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({
          kind: 'drawing-v5',
          requestId,
          projectId: input.documentValue.projectId,
          revision: 1,
          document: input.documentValue,
          views: ['front', 'top', 'right', 'iso'],
        });
      });
      return {
        id: input.id,
        kind: String(response.kind || ''),
        errors: (response.errors || []).map((entry: Record<string, any>) => ({
          featureType: entry.featureType,
          message: entry.message,
        })),
        views: Array.isArray(response.views) ? response.views.map((entry: Record<string, any>) => ({
          view: String(entry.view || ''),
          visibleCount: Array.isArray(entry.visible) ? entry.visible.length : 0,
          hiddenCount: Array.isArray(entry.hidden) ? entry.hidden.length : 0,
          viewBox: Array.isArray(entry.viewBox) ? [...entry.viewBox] : [],
        })) : null,
        manifest: response.manifest ? JSON.parse(JSON.stringify(response.manifest)) : null,
      };
    } finally {
      worker.terminate();
    }
  }, { id, documentValue }) as Promise<DrawingSummary>;
}

async function runMassInspection(page: Page, documentValue: JsonDocument): Promise<Record<string, any>> {
  return page.evaluate(async (input) => {
    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    if (!studioScript) throw new Error('versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    const worker = new Worker(workerUrl, { type: 'module' });
    try {
      const requestId = 'assembly-mass-properties';
      const response = await new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(() => rejectResponse(new Error('mass-properties inspection timed out')), 180_000);
        const onMessage = (event: MessageEvent<Record<string, any>>) => {
          const data = event.data;
          if (data?.kind === 'kernel-status' && data.status === 'failed') {
            clearTimeout(timeout);
            worker.removeEventListener('message', onMessage);
            rejectResponse(new Error(data.message || 'CAD kernel initialization failed'));
            return;
          }
          if (data?.requestId !== requestId) return;
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          if (data.kind === 'kernel-error') rejectResponse(new Error(data.message || 'CAD kernel error'));
          else resolveResponse(JSON.parse(JSON.stringify(data)));
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({
          kind: 'inspect-v5',
          requestId,
          projectId: input.documentValue.projectId,
          revision: 1,
          document: input.documentValue,
          mode: 'mass-health',
        });
      });
      return response;
    } finally {
      worker.terminate();
    }
  }, { documentValue }) as Promise<Record<string, any>>;
}

const projectModule = await import(pathToFileURL(resolve(root, 'src', 'static', 'studio-project-v5.js')).href) as any;
const runtimeModule = await import(pathToFileURL(resolve(root, 'src', 'static', 'studio-v5-runtime-document.js')).href) as any;
const inspectionModule = await import(pathToFileURL(resolve(root, 'src', 'static', 'studio-v5-inspection.js')).href) as any;
const prepareStudioV5Project = projectModule.prepareStudioV5Project as (candidate: JsonDocument) => JsonDocument;
const parseStudioV5Project = projectModule.parseStudioV5Project as (source: string) => JsonDocument;
const studioV5CanonicalHash = runtimeModule.studioV5CanonicalHash as (candidate: JsonDocument) => string;
const ensureStudioV5GenericMaterials = inspectionModule.ensureStudioV5GenericMaterials as (candidate: JsonDocument) => JsonDocument;
const assignStudioV5BodyMaterial = inspectionModule.assignStudioV5BodyMaterial as (
  candidate: JsonDocument, partId: string, bodyId: string, materialId: string,
) => JsonDocument;
const createStudioV5SectionView = inspectionModule.createStudioV5SectionView as (candidate: JsonDocument, input: JsonDocument) => JsonDocument;
const createStudioV5Measurement = inspectionModule.createStudioV5Measurement as (candidate: JsonDocument, input: JsonDocument) => JsonDocument;
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonDocument;

function saveReopen(candidate: JsonDocument, label: string): JsonDocument {
  const prepared = prepareStudioV5Project(clone(candidate));
  const saved = JSON.stringify(prepared);
  const reopened = parseStudioV5Project(saved);
  invariant(JSON.stringify(reopened) === saved, `${label}: save/reopen changed canonical JSON`);
  invariant(studioV5CanonicalHash(reopened) === studioV5CanonicalHash(parseStudioV5Project(JSON.stringify(reopened))),
    `${label}: canonical hash changed on a second reopen`);
  return reopened;
}

const base = saveReopen(fixture, 'base');
const reopened = saveReopen(base, 'reopened');
invariant(studioV5CanonicalHash(base) === studioV5CanonicalHash(reopened), 'save/reopen changed the assembly document hash');
const reversedSource = clone(reopened);
reversedSource.assemblyDefinitions[0].mates.reverse();
const reversed = saveReopen(reversedSource, 'mate-order reversal');
const incompleteSource = clone(reopened);
const movingPart = incompleteSource.partDefinitions.find((entry: Record<string, any>) => entry.id === 'part-moving-block');
const missingDatum = movingPart.referenceGeometry.find((entry: Record<string, any>) => entry.id === 'datum-moving-y');
missingDatum.suppressed = true;
const incomplete = saveReopen(incompleteSource, 'incomplete mate reference');
let materializedSource = clone(reopened);
materializedSource = ensureStudioV5GenericMaterials(materializedSource);
materializedSource = assignStudioV5BodyMaterial(
  materializedSource, 'part-base-block', 'body-base-block', 'material-generic-steel',
);
materializedSource = assignStudioV5BodyMaterial(
  materializedSource, 'part-moving-block', 'body-moving-block', 'material-generic-aluminum',
);
materializedSource = createStudioV5SectionView(materializedSource, {
  id: 'section-runtime-longitudinal',
  name: 'Runtime longitudinal section',
  kind: 'plane',
  definition: {
    planes: [{ normal: [1, 0, 0], offset: 0 }],
    cap: true,
    reverse: false,
    scopeOccurrenceIds: [],
    hatch: { enabled: true, spacing: 8, angle: 45, color: '#243746', fillColor: '#d7e0e5' },
  },
});
delete materializedSource.assemblyDefinitions[0].metadata.activeSectionViewId;
materializedSource = createStudioV5Measurement(materializedSource, {
  id: 'measurement-runtime-base-envelope',
  name: 'Base envelope',
  kind: 'bounding-box',
  definition: { bodyIds: ['occurrence-base:body-base-block'] },
});
materializedSource = createStudioV5Measurement(materializedSource, {
  id: 'measurement-runtime-interface-clearance',
  name: 'Interface clearance',
  kind: 'minimum-clearance',
  definition: { bodyIds: ['occurrence-base:body-base-block', 'occurrence-moving:body-moving-block'] },
});
const materialized = saveReopen(materializedSource, 'material mass properties');

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-assembly-runtime-'));
const materializedFixturePath = resolve(temporaryDirectory, 'two-part-materialized.partmode.json');
writeFileSync(materializedFixturePath, JSON.stringify(materialized), 'utf8');
let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;

try {
  local = await startPartModeServer({
    distDir: resolve(root, 'dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  const health = await fetch(new URL('/healthz', local.url));
  invariant(health.ok, `local PartMode health returned HTTP ${health.status}`);
  browser = await puppeteer.launch({
    headless: true,
    // One Runtime.callFunctionOn can contain three independently bounded
    // 120-second exact rebuilds. Keep the outer DevTools ceiling above that
    // aggregate while preserving every per-operation kernel timeout below.
    protocolTimeout: 600_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  // Pre-consent to essential cookies so the consent banner never overlays the
  // inspector controls this suite drives with real mouse clicks.
  await page.evaluateOnNewDocument(() => {
    document.cookie = 'partmode_cookie_consent=essential-v1; Path=/';
  });
  const response = await page.goto(local.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  invariant(response?.status() === 200, `local PartMode page returned HTTP ${response?.status() ?? 0}`);
  // Let the versioned Studio module graph and blank-project boot settle before
  // direct exact workers compete for CPU. Launching all workers at
  // DOMContentLoaded can starve the main app before its handlers are attached.
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  await page.waitForFunction(() => Boolean((window as any).__bwStudio), { timeout: 120_000 });
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio?.documentRevision?.() === studio?.appliedRevision?.()
      && studio?.mode?.()?.kind !== 'rebuilding';
  }, { polling: 50, timeout: 180_000 });
  console.log('assembly runtime visible Studio boot settled');

  const valid = await runRebuildSequence(page, 'assembly-runtime-valid', [
    { id: 'base', document: base },
    { id: 'save-reopen', document: reopened },
    { id: 'mates-reversed', document: reversed },
  ]);
  valid.forEach((result, index) => assertSolved(result, index === 0));
  console.log('assembly runtime exact rebuild sequence settled');
  const baselineEvidence = stableRebuildEvidence(valid[0]!);
  invariant(JSON.stringify(stableRebuildEvidence(valid[1]!)) === JSON.stringify(baselineEvidence),
    'save/reopen changed solved placement, rank/DOF, exact body evidence, or topology counts');
  invariant(JSON.stringify(stableRebuildEvidence(valid[2]!)) === JSON.stringify(baselineEvidence),
    'mate declaration order changed solved placement, rank/DOF, exact body evidence, or topology counts');

  const drawing = await runDrawing(page, 'valid', reopened);
  assertAssemblyDrawing(drawing);
  console.log('assembly runtime exact drawing settled');

  const massInspection = await runMassInspection(page, materialized);
  invariant(massInspection.kind === 'inspection-result', `mass properties returned ${String(massInspection.kind)}`);
  invariant((massInspection.errors || []).length === 0,
    `mass properties returned errors ${JSON.stringify(massInspection.errors || [])}`);
  const properties = massInspection.inspection?.properties || [];
  invariant(properties.length === 2, `mass properties returned ${properties.length} body records`);
  const baseProperties = properties.find((entry: Record<string, any>) => entry.sourceBodyId === 'body-base-block');
  const movingProperties = properties.find((entry: Record<string, any>) => entry.sourceBodyId === 'body-moving-block');
  invariant(baseProperties && movingProperties, 'mass properties did not preserve source-body identity');
  const baseMass = 20 * 10 * 8 * 1e-9 * 7850;
  const movingMass = 12 * 8 * 14 * 1e-9 * 2700;
  const totalMass = baseMass + movingMass;
  const baseCenter = [0, 0, 4];
  const movingCenter = [16, -1, 7];
  sameNumbers(baseProperties.centerOfMassMm, [0, 0, 4], 'base center of mass', 2e-7);
  sameNumbers(movingProperties.centerOfMassMm, movingCenter, 'moving center of mass', 2e-7);
  invariant(Math.abs(baseProperties.massKg - baseMass) <= 1e-12, 'base material density did not drive exact mass');
  invariant(Math.abs(movingProperties.massKg - movingMass) <= 1e-12, 'moving material density did not drive exact mass');
  sameMatrix(baseProperties.massInertiaTensorKgMm2, boxInertia(baseMass, [20, 10, 8]),
    'base center-of-mass inertia', 2e-8);
  sameMatrix(movingProperties.massInertiaTensorKgMm2, boxInertia(movingMass, [12, 8, 14]),
    'moving center-of-mass inertia', 2e-8);
  const expectedCenter = [
    movingMass * 16 / totalMass,
    movingMass * -1 / totalMass,
    (baseMass * 4 + movingMass * 7) / totalMass,
  ];
  const expectedAssemblyTensor = addMatrices(
    shiftedInertia(boxInertia(baseMass, [20, 10, 8]), baseMass, baseCenter, expectedCenter),
    shiftedInertia(boxInertia(movingMass, [12, 8, 14]), movingMass, movingCenter, expectedCenter),
  );
  const aggregate = massInspection.inspection.aggregate;
  invariant(Math.abs(aggregate.massKg - totalMass) <= 1e-12, 'aggregate material mass is wrong');
  sameNumbers(aggregate.centerOfMassMm, expectedCenter, 'aggregate center of mass', 2e-7);
  sameNumbers(aggregate.inertiaReferencePointMm, expectedCenter, 'aggregate inertia reference', 2e-7);
  sameMatrix(aggregate.massInertiaTensorKgMm2, expectedAssemblyTensor, 'aggregate mass inertia', 2e-8);
  const principalMoments = aggregate.principalMomentsKgMm2 as number[];
  invariant(principalMoments.length === 3 && principalMoments[0]! <= principalMoments[1]!
    && principalMoments[1]! <= principalMoments[2]!, 'aggregate principal moments are not sorted');
  const tensorTrace = expectedAssemblyTensor[0]![0]! + expectedAssemblyTensor[1]![1]! + expectedAssemblyTensor[2]![2]!;
  const tensorSquareTrace = expectedAssemblyTensor.reduce((total, row, rowIndex) => total + row.reduce(
    (rowTotal, value, columnIndex) => rowTotal + value * expectedAssemblyTensor[columnIndex]![rowIndex]!, 0,
  ), 0);
  const tensorPairInvariant = (tensorTrace * tensorTrace - tensorSquareTrace) / 2;
  const tensorDeterminant =
    expectedAssemblyTensor[0]![0]! * (expectedAssemblyTensor[1]![1]! * expectedAssemblyTensor[2]![2]! - expectedAssemblyTensor[1]![2]! * expectedAssemblyTensor[2]![1]!) -
    expectedAssemblyTensor[0]![1]! * (expectedAssemblyTensor[1]![0]! * expectedAssemblyTensor[2]![2]! - expectedAssemblyTensor[1]![2]! * expectedAssemblyTensor[2]![0]!) +
    expectedAssemblyTensor[0]![2]! * (expectedAssemblyTensor[1]![0]! * expectedAssemblyTensor[2]![1]! - expectedAssemblyTensor[1]![1]! * expectedAssemblyTensor[2]![0]!);
  invariant(Math.abs(principalMoments.reduce((sum, value) => sum + value, 0) - tensorTrace) <= 2e-8,
    'principal moments do not preserve tensor trace');
  invariant(Math.abs(
    principalMoments[0]! * principalMoments[1]! + principalMoments[0]! * principalMoments[2]! + principalMoments[1]! * principalMoments[2]! - tensorPairInvariant,
  ) <= 2e-8, 'principal moments do not preserve the second tensor invariant');
  invariant(Math.abs(principalMoments.reduce((product, value) => product * value, 1) - tensorDeterminant) <= 2e-8,
    'principal moments do not preserve tensor determinant');
  invariant(aggregate.principalAxes.length === 3, 'aggregate principal axes are missing');
  aggregate.principalAxes.forEach((axis: number[], index: number) => {
    invariant(Math.abs(Math.hypot(...axis) - 1) <= 1e-10, `principal axis ${index} is not normalized`);
    const transformed = expectedAssemblyTensor.map((row) => row.reduce((sum, value, column) => sum + value * axis[column]!, 0));
    sameNumbers(transformed, axis.map((value) => value * aggregate.principalMomentsKgMm2[index]),
      `principal axis ${index} eigenpair`, 2e-8);
  });
  invariant(Math.abs(aggregate.principalAxes[0].reduce((sum: number, value: number, axis: number) =>
    sum + value * aggregate.principalAxes[1][axis], 0)) <= 1e-10, 'principal axes are not orthogonal');
  console.log('assembly runtime exact mass inspection settled');

  const projectInput = await page.$('#bw-open-file') as ElementHandle<HTMLInputElement> | null;
  invariant(projectInput, 'visible Studio project-file input is missing');
  await projectInput.uploadFile(materializedFixturePath);
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    if (!studio) return false;
    try {
      const documentValue = JSON.parse(studio.docJson());
      return documentValue.rootDocument?.kind === 'assembly'
        && studio.documentRevision() === studio.appliedRevision()
        && studio.bodyResults().filter((entry: Record<string, any>) => entry.visible !== false && !entry.suppressed).length === 2;
    } catch {
      return false;
    }
  }, { polling: 50, timeout: 180_000 });

  await page.evaluate(() => (window as any).__bwStudio.selectOccurrenceForTest('occurrence-moving'));
  await page.waitForSelector('[data-occurrence-context="edit"]', { visible: true, timeout: 30_000 });
  await page.click('[data-occurrence-context="edit"]');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    const banner = document.querySelector('#bw-edit-context-banner');
    return studio?.rootKind?.() === 'part'
      && studio.documentRevision() === studio.appliedRevision()
      && studio.bodyResults().length === 2
      && banner instanceof HTMLElement
      && !banner.hidden;
  }, { polling: 50, timeout: 180_000 });
  const editContextUi = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    studio.selectBodyForTest('occurrence-moving:body-moving-block');
    const topology = studio.topologyInventoryForTest();
    return {
      rootKind: studio.rootKind(),
      suffix: document.querySelector('#bw-document-suffix')?.textContent || '',
      banner: document.querySelector('#bw-edit-context-banner')?.textContent || '',
      active: studio.bodyDisplayState('occurrence-moving:body-moving-block'),
      surrounding: studio.bodyDisplayState('occurrence-base:body-base-block'),
      selectedBodyId: studio.selectedBodyId(),
      selectedOccurrenceId: studio.selectedOccurrenceId(),
      topologyCount: topology.length,
      topologyOwnerIds: [...new Set(topology.map((entry: Record<string, any>) => entry.owner?.id))],
      topologyLeaksRuntimeId: topology.some((entry: Record<string, any>) => '_runtimeBodyId' in entry),
    };
  });
  invariant(editContextUi.rootKind === 'part' && editContextUi.suffix.includes('In-context Part Design'),
    `visible Studio did not switch to in-context Part Design ${JSON.stringify(editContextUi)}`);
  invariant(editContextUi.banner.includes('Editing in assembly context')
    && editContextUi.banner.includes('Moving block')
    && editContextUi.banner.includes('Return to assembly'),
  `visible context banner is incomplete ${JSON.stringify(editContextUi.banner)}`);
  invariant(editContextUi.active?.editContextRole === 'active'
    && editContextUi.active.displayMode !== 'edit-context-ghost'
    && editContextUi.active.opacity === 1,
  `active part is not rendered as editable solid geometry ${JSON.stringify(editContextUi.active)}`);
  invariant(editContextUi.surrounding?.editContextRole === 'surrounding'
    && editContextUi.surrounding.displayMode === 'edit-context-ghost'
    && editContextUi.surrounding.opacity === 0.16
    && editContextUi.surrounding.transparent === true,
  `surrounding component is not rendered as a ghost ${JSON.stringify(editContextUi.surrounding)}`);
  invariant(editContextUi.selectedBodyId === 'body-moving-block' && editContextUi.selectedOccurrenceId === null,
    `active runtime selection did not map to the editable source body ${JSON.stringify(editContextUi)}`);
  invariant(editContextUi.topologyCount > 0
    && JSON.stringify(editContextUi.topologyOwnerIds) === JSON.stringify(['body-moving-block'])
    && editContextUi.topologyLeaksRuntimeId === false,
  `public topology did not isolate the editable source body ${JSON.stringify(editContextUi)}`);

  await page.click('#bw-edit-context-banner [data-assembly-command="exit-context"]');
  await page.waitForSelector('#bw-v5-command[open]', { visible: true, timeout: 30_000 });
  const exitTitle = await page.$eval('#bw-v5-command-title', (entry) => entry.textContent || '');
  invariant(exitTitle === 'Return to assembly', `return control opened ${JSON.stringify(exitTitle)}`);
  await page.click('#bw-v5-command-apply');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    const banner = document.querySelector('#bw-edit-context-banner');
    return studio?.rootKind?.() === 'assembly'
      && studio.documentRevision() === studio.appliedRevision()
      && studio.bodyResults().length === 2
      && banner instanceof HTMLElement
      && banner.hidden;
  }, { polling: 50, timeout: 180_000 });
  console.log('assembly runtime visible edit context settled');

  const visibleMeshExportButtons = await page.evaluate(() => ['amf', '3mf'].every((format) => {
    const button = document.querySelector(`#bw-export-${format}`);
    const ribbon = document.querySelector(`[data-command-target="bw-export-${format}"]`);
    return button instanceof HTMLButtonElement && ribbon instanceof HTMLButtonElement;
  }));
  invariant(visibleMeshExportButtons, 'visible Studio omits AMF or 3MF export controls');
  const renderedMaterials = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    return {
      base: studio.bodyDisplayState('occurrence-base:body-base-block'),
      moving: studio.bodyDisplayState('occurrence-moving:body-moving-block'),
      projectMaterials: JSON.parse(studio.docJson()).materials,
    };
  });
  invariant(renderedMaterials.projectMaterials.length === 9,
    `generic material library contains ${renderedMaterials.projectMaterials.length} entries`);
  invariant(renderedMaterials.base?.color === '#687785' && renderedMaterials.base.metalness === 0.78
    && renderedMaterials.base.roughness === 0.34 && renderedMaterials.base.opacity === 1,
  `generic steel appearance did not reach the viewport ${JSON.stringify(renderedMaterials.base)}`);
  invariant(renderedMaterials.moving?.color === '#9aa9b5' && renderedMaterials.moving.metalness === 0.72
    && renderedMaterials.moving.roughness === 0.38 && renderedMaterials.moving.opacity === 1,
  `generic aluminum appearance did not reach the viewport ${JSON.stringify(renderedMaterials.moving)}`);
  await page.evaluate(() => (window as any).__bwStudio.selectOccurrenceForTest('occurrence-base'));
  await page.click('[data-inspection-command="material"]');
  await page.waitForSelector('#bw-v5-command[open] select[name="materialId"]', { visible: true, timeout: 30_000 });
  const materialDialog = await page.evaluate(() => ({
    title: document.querySelector('#bw-v5-command-title')?.textContent || '',
    options: [...document.querySelectorAll('#bw-v5-command select[name="materialId"] option')]
      .map((entry) => entry.textContent || ''),
  }));
  invariant(materialDialog.title === 'Assign material and appearance' && materialDialog.options.length === 9,
    `visible material library dialog is incomplete ${JSON.stringify(materialDialog)}`);
  invariant(materialDialog.options.some((entry) => entry.includes('Generic steel'))
    && materialDialog.options.some((entry) => entry.includes('Generic aluminum')),
  'visible material library dialog omits its engineering materials');
  await page.click('#bw-v5-command-cancel');
  await page.evaluate(() => (window as any).__bwStudio.selectOccurrenceForTest(null));
  const meshExports = await page.evaluate(async () => {
    const studio = (window as any).__bwStudio;
    return {
      amf: await studio.exportForTest('amf') as MeshExportSummary,
      amfRepeat: await studio.exportForTest('amf') as MeshExportSummary,
      threeMf: await studio.exportForTest('3mf') as MeshExportSummary,
      threeMfRepeat: await studio.exportForTest('3mf') as MeshExportSummary,
    };
  });
  for (const [label, result] of Object.entries(meshExports)) {
    invariant(result.size > 0 && result.bytes.length === result.size, `${label} export byte count is wrong`);
    invariant(result.errors.length === 0, `${label} export failed ${JSON.stringify(result.errors)}`);
    invariant(result.manifest?.bodyCount === 2 && result.manifest?.units === 'mm',
      `${label} manifest does not prove two millimetre bodies`);
  }
  invariant(meshExports.amf.type === 'application/x-amf', `AMF MIME type is ${meshExports.amf.type}`);
  invariant(meshExports.threeMf.type === 'model/3mf', `3MF MIME type is ${meshExports.threeMf.type}`);
  invariant(JSON.stringify(meshExports.amf.bytes) === JSON.stringify(meshExports.amfRepeat.bytes),
    'AMF bytes are not deterministic across fresh kernel workers');
  invariant(JSON.stringify(meshExports.threeMf.bytes) === JSON.stringify(meshExports.threeMfRepeat.bytes),
    '3MF bytes are not deterministic across fresh kernel workers');
  invariant(meshExports.amf.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'),
    'AMF XML declaration is missing');
  invariant(meshExports.amf.text.includes('<amf unit="millimeter" version="1.2">'),
    'AMF does not declare millimetre units and version 1.2');
  const amfMeshes = parseAmfMeshes(meshExports.amf.text);
  const expectedMeshNames = meshExports.amf.manifest?.names as string[];
  invariant(Array.isArray(expectedMeshNames) && expectedMeshNames.length === 2, 'mesh export manifest names are missing');
  assertExchangeMeshes(amfMeshes, expectedMeshNames);

  const packageEntries = storedZipEntries(meshExports.threeMf.bytes);
  invariant(JSON.stringify([...packageEntries.keys()]) === JSON.stringify([
    '[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model',
  ]), `3MF package entries are wrong ${JSON.stringify([...packageEntries.keys()])}`);
  const packageDecoder = new TextDecoder();
  const contentTypes = packageDecoder.decode(packageEntries.get('[Content_Types].xml'));
  const relationships = packageDecoder.decode(packageEntries.get('_rels/.rels'));
  const modelXml = packageDecoder.decode(packageEntries.get('3D/3dmodel.model'));
  invariant(contentTypes.includes('application/vnd.ms-package.3dmanufacturing-3dmodel+xml'),
    '3MF package does not register its 3D model content type');
  invariant(relationships.includes('Target="/3D/3dmodel.model"')
    && relationships.includes('http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel'),
  '3MF package does not point its required relationship at the model part');
  invariant(modelXml.includes('unit="millimeter"')
    && modelXml.includes('xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"'),
  '3MF model does not declare the core namespace and millimetre units');
  invariant((modelXml.match(/<item objectid="\d+"\/>/g) || []).length === 2,
    '3MF build does not instantiate both named mesh objects');
  const threeMfMeshes = parseThreeMfMeshes(modelXml);
  assertExchangeMeshes(threeMfMeshes, expectedMeshNames);
  invariant(JSON.stringify(threeMfMeshes) === JSON.stringify(amfMeshes),
    'AMF and 3MF do not carry identical named tessellations');

  const visibleInspectionControls = await page.evaluate(() => [
    'section', 'measure', 'measurements',
  ].every((command) => document.querySelector(`[data-inspection-command="${command}"]`) instanceof HTMLButtonElement));
  invariant(visibleInspectionControls, 'visible Studio omits section or measurement controls');
  await page.waitForSelector('[data-inspection-kind="section"][data-inspection-id="section-runtime-longitudinal"] [data-inspection-action="toggle"]', {
    visible: true,
    timeout: 60_000,
  });
  await page.click('[data-inspection-kind="section"][data-inspection-id="section-runtime-longitudinal"] [data-inspection-action="toggle"]');
  await page.waitForFunction(() => {
    const studio = (window as any).__bwStudio;
    return studio?.activeSectionViewId?.() === 'section-runtime-longitudinal';
  }, { polling: 50, timeout: 60_000 });
  await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))));
  const sectionState = await page.evaluate(() => {
    const studio = (window as any).__bwStudio;
    const before = studio.sectionCapState();
    const updatedMaterials = studio.sectionPlaneOffsetForTest(2);
    const after = studio.sectionCapState();
    return { before, after, updatedMaterials };
  });
  invariant(sectionState.before.planes === 1 && sectionState.before.capPositions.length === 1
    && sectionState.before.stencilMeshes === 4 && sectionState.before.stencilDrawObjects === 2
    && sectionState.before.extensionIndependent === true,
  `visible section view cap state is wrong ${JSON.stringify(sectionState.before)}`);
  invariant(sectionState.updatedMaterials > 2, 'interactive section offset did not update viewport clipping materials');
  sameNumbers(sectionState.after.capPositions[0], [2, sectionState.before.capPositions[0][1], sectionState.before.capPositions[0][2]],
    'interactive section cap position', 1e-7);

  await page.click('[data-inspection-command="measurements"]');
  await page.waitForFunction(() => {
    const results = (window as any).__bwStudio?.inspectionResult?.()?.measurementResults;
    return Array.isArray(results) && results.length === 2;
  }, { polling: 50, timeout: 180_000 });
  const visibleMeasurements = await page.evaluate(() => ({
    saved: (window as any).__bwStudio.measurements(),
    evaluated: (window as any).__bwStudio.inspectionResult().measurementResults,
    text: document.querySelector('#bw-context')?.textContent || '',
  }));
  invariant(visibleMeasurements.saved.length === 2, 'visible measure tool did not preserve both saved measurements');
  const envelopeMeasurement = visibleMeasurements.evaluated.find((entry: Record<string, any>) =>
    entry.id === 'measurement-runtime-base-envelope');
  const clearanceMeasurement = visibleMeasurements.evaluated.find((entry: Record<string, any>) =>
    entry.id === 'measurement-runtime-interface-clearance');
  invariant(envelopeMeasurement?.valid === true && clearanceMeasurement?.valid === true,
    `visible exact measurements are invalid ${JSON.stringify(visibleMeasurements.evaluated)}`);
  sameNumbers(envelopeMeasurement.value, [20, 10, 8], 'visible bounding-box measurement', 5e-7);
  invariant(Math.abs(clearanceMeasurement.value) <= 1e-9,
    `visible exact interface clearance is ${clearanceMeasurement.value}`);
  invariant(visibleMeasurements.text.includes('Base envelope: 20.000 × 10.000 × 8.000 mm')
    && visibleMeasurements.text.includes('Interface clearance: 0.000 mm'),
  `visible inspector does not display the evaluated exact measurements ${JSON.stringify(visibleMeasurements.text)}`);

  const visibleSheet = await page.evaluate(async () => (window as any).__bwStudio.drawingForTest());
  invariant(visibleSheet?.svg, 'visible Studio did not generate the assembly SVG sheet');
  invariant(visibleSheet.svg.includes('class="assembly-bom"'), 'visible assembly SVG omits its BOM table');
  invariant(visibleSheet.svg.includes('data-bom-rows="2"'), 'visible assembly SVG BOM row count is wrong');
  invariant(visibleSheet.svg.includes('class="assembly-balloon"'), 'visible assembly SVG omits its balloons');
  invariant((visibleSheet.svg.match(/class="assembly-balloon"/g) || []).length === 2,
    'visible assembly SVG does not contain exactly two balloons');
  invariant(visibleSheet.svg.includes('PM-BASE-100') && visibleSheet.svg.includes('PM-MOVING-200'),
    'visible assembly SVG omits deterministic part numbers');
  await page.click('[data-inspection-command="properties"]');
  await page.waitForFunction(() => {
    const inspection = (window as any).__bwStudio?.inspectionResult?.();
    return Array.isArray(inspection?.aggregate?.principalMomentsKgMm2)
      && inspection.aggregate.principalMomentsKgMm2.length === 3;
  }, { polling: 50, timeout: 180_000 });
  const visibleMassInspection = await page.evaluate(() => ({
    inspection: (window as any).__bwStudio.inspectionResult(),
    text: document.querySelector('#bw-context')?.textContent || '',
  }));
  sameMatrix(visibleMassInspection.inspection.aggregate.massInertiaTensorKgMm2,
    expectedAssemblyTensor, 'visible aggregate mass inertia', 2e-8);
  invariant(visibleMassInspection.text.includes('Center of mass:'), 'visible inspector omits center of mass');
  invariant(visibleMassInspection.text.includes('Principal inertia:'), 'visible inspector omits principal inertia');
  invariant(!visibleMassInspection.text.includes('Principal inertia: unknown'),
    'visible inspector did not apply complete material density');

  const coldInvalid = (await runRebuildSequence(page, 'assembly-runtime-incomplete', [
    { id: 'incomplete-reference', document: incomplete },
  ]))[0]!;
  invariant(coldInvalid.kind === 'rebuild-result', 'incomplete reference did not return an explicit rebuild result');
  invariant(coldInvalid.errors.length === 1, `incomplete reference returned ${coldInvalid.errors.length} errors`);
  invariant(coldInvalid.errors[0]?.mateId === 'mate-corner-y',
    `incomplete reference error did not identify mate-corner-y ${JSON.stringify(coldInvalid.errors)}`);
  invariant(String(coldInvalid.errors[0]?.message).includes('suppressed'),
    `incomplete reference error is not diagnostic ${JSON.stringify(coldInvalid.errors)}`);
  invariant(coldInvalid.evaluation.solverState === 'conflicting',
    `incomplete reference solver state is ${String(coldInvalid.evaluation.solverState)}`);
  invariant(coldInvalid.evaluation.solverRank === 5,
    `incomplete reference expected rank 5, received ${String(coldInvalid.evaluation.solverRank)}`);
  invariant(coldInvalid.evaluation.degreesOfFreedom?.['occurrence-moving'] === 1,
    'incomplete reference did not surface one unresolved moving DOF');
  invariant(coldInvalid.evaluation.usedLastValid === false,
    'cold incomplete-reference rebuild silently used a last-valid placement');

  const invalidDrawing = await runDrawing(page, 'incomplete-reference', incomplete);
  invariant(invalidDrawing.kind === 'drawing-result', 'incomplete-reference drawing did not return drawing-result');
  invariant(invalidDrawing.errors.length > 0, 'incomplete-reference drawing did not fail closed');
  invariant(invalidDrawing.views === null, 'incomplete-reference drawing emitted projection views');
  invariant(invalidDrawing.manifest === null, 'incomplete-reference drawing emitted a BOM or balloon manifest');

  console.log(JSON.stringify({
    ok: true,
    exactAssemblyRebuilds: valid.length + 1,
    deterministicMateOrder: true,
    saveReopenStable: true,
    solver: {
      state: valid[0]!.evaluation.solverState,
      rank: valid[0]!.evaluation.solverRank,
      degreesOfFreedom: valid[0]!.evaluation.degreesOfFreedom,
      components: valid[0]!.evaluation.solverComponents.length,
    },
    drawing: {
      exactEvidence: exactDrawingEvidence(drawing.manifest || {})?.kind,
      views: drawing.views?.map((entry) => entry.view),
      bomRows: drawing.manifest?.bom?.length,
      balloons: drawingBalloons(drawing.manifest || {}).length,
      visibleSvgBomRows: 2,
      visibleSvgBalloons: 2,
    },
    massProperties: {
      bodies: properties.length,
      materialMassKg: aggregate.massKg,
      centerOfMassMm: aggregate.centerOfMassMm,
      principalMomentsKgMm2: aggregate.principalMomentsKgMm2,
      exactOcctAxisMoments: true,
      visibleInspector: true,
    },
    materialLibraryAndAppearance: {
      materials: renderedMaterials.projectMaterials.length,
      visibleAssignmentDialog: true,
      densityDrivenMass: true,
      viewportBaseColors: [renderedMaterials.base.color, renderedMaterials.moving.color],
      metalness: [renderedMaterials.base.metalness, renderedMaterials.moving.metalness],
      roughness: [renderedMaterials.base.roughness, renderedMaterials.moving.roughness],
    },
    namedMeshExchange: {
      formats: ['amf', '3mf'],
      bodies: amfMeshes.length,
      units: 'mm',
      deterministic: true,
      packageEntries: [...packageEntries.keys()],
      exactBoundsAndVolumes: true,
      visibleControls: true,
    },
    modelingWindowInspectionUi: {
      sectionControls: true,
      activeSectionId: 'section-runtime-longitudinal',
      clippingPlanes: sectionState.before.planes,
      stencilMeshes: sectionState.before.stencilMeshes,
      interactiveOffset: true,
      savedMeasurements: visibleMeasurements.saved.length,
      exactBoundingBoxMm: envelopeMeasurement.value,
      exactMinimumClearanceMm: clearanceMeasurement.value,
      visibleResults: true,
    },
    assemblyEditContext: {
      ghostedSurroundings: true,
      activeBodyId: editContextUi.selectedBodyId,
      topologyOwnerIds: editContextUi.topologyOwnerIds,
      returnControl: true,
    },
    incompleteReference: {
      state: coldInvalid.evaluation.solverState,
      rank: coldInvalid.evaluation.solverRank,
      movingDegreesOfFreedom: coldInvalid.evaluation.degreesOfFreedom?.['occurrence-moving'],
      drawingFailedClosed: true,
    },
  }));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
