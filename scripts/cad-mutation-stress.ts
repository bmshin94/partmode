import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonDocument = Record<string, any>;

interface StressOptions {
  mode: 'default-exhaustive' | 'exhaustive' | 'focused' | 'custom';
  professionalCoreAcceptance: boolean;
  models: number;
  cycles: number;
  invalidEvery: number;
  progressEvery: number;
  requestTimeoutMs: number;
  seed: number;
  scenarioOffset: number;
  jobs: number;
  checkpointPath?: string;
  resume: boolean;
}

interface ModelIds {
  partId: string;
  stockBodyId: string;
  witnessBodyId: string;
  stockFeatureId: string;
  filletFeatureId: string;
  witnessFeatureId: string;
  stockLine2Id: string;
  selectedEdgeName: string;
  invalidEdgeName: string;
}

interface MutationRoute {
  id: string;
  editedFeatureTypes: string[];
  evaluatedFeatureIds: string[];
  changedBodyIds: string[];
  topologyChangeBodyIds?: string[];
  apply: (document: JsonDocument, fraction: number) => void;
}

interface ScenarioDefinition {
  id: string;
  source: string;
  document: JsonDocument;
  meaningfulFeatureTypes: string[];
  routes: MutationRoute[];
}

interface MutationExpectation {
  routeId: string;
  editedFeatureTypes: string[];
  evaluatedFeatureIds: string[];
  reusedFeatureIds: string[];
  changedBodyIds: string[];
  unchangedBodyIds: string[];
  topologyChangeBodyIds: string[];
}

interface PreparedPair {
  incrementalDocument: JsonDocument;
  coldDocument: JsonDocument;
  orderedHash: string;
  shuffledHash: string;
}

interface PreparedCycle extends PreparedPair {
  cycle: number;
  expectation: MutationExpectation;
  runInvalidProbe: boolean;
}

interface PreparedModel {
  id: string;
  scenarioId: string;
  scenarioSource: string;
  meaningfulFeatureTypes: string[];
  allFeatureIds: string[];
  allBodyIds: string[];
  ids: ModelIds;
  requiredNameKeys: string[];
  baseline: PreparedPair;
  cycles: PreparedCycle[];
}

interface BrowserModelResult {
  modelId: string;
  scenarioId: string;
  meaningfulFeatureTypes: string[];
  editTypeCounts: Record<string, number>;
  cycles: number;
  invalidProbes: number;
  namedTopologyCount: number;
  baselineDigest: string;
  finalDigest: string;
  topologyIdentityDigest: string;
  topologyHistoryDigest: string;
}

interface CheckpointModelResult {
  modelIndex: number;
  inputDigest: string;
  result: BrowserModelResult;
}

interface StressCheckpoint {
  format: 'partmode-cad-mutation-stress/v4';
  status: 'running' | 'ok';
  suiteFingerprint: string;
  distFingerprint: string;
  configuration: {
    professionalCoreAcceptance: boolean;
    models: number;
    cycles: number;
    invalidEvery: number;
    seed: number;
    scenarioOffset: number;
    scenarioIds: string[];
    registeredFeatureTypes: string[];
  };
  results: CheckpointModelResult[];
  checkpointDigest: string;
}

interface SchemaApi {
  prepareStudioV5Project: (candidate: JsonDocument) => JsonDocument;
  parseStudioV5Project: (source: string) => JsonDocument;
  studioV5CanonicalHash: (candidate: JsonDocument) => string;
  featureTypes: string[];
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..', '..');

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256Node(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprintFiles(paths: string[]): string {
  const hash = createHash('sha256');
  for (const path of [...paths].sort()) {
    invariant(existsSync(path) && statSync(path).isFile(), `fingerprint input is not a file: ${path}`);
    hash.update(path.slice(repositoryRoot.length));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function directoryFingerprint(root: string): string {
  invariant(existsSync(root) && statSync(root).isDirectory(), `fingerprint input is not a directory: ${root}`);
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = resolve(directory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error(`unsupported dist entry in fingerprint: ${path}`);
    }
  };
  visit(root);
  return fingerprintFiles(files);
}

function checkpointPayload(checkpoint: StressCheckpoint): Omit<StressCheckpoint, 'checkpointDigest'> {
  return {
    format: checkpoint.format,
    status: checkpoint.status,
    suiteFingerprint: checkpoint.suiteFingerprint,
    distFingerprint: checkpoint.distFingerprint,
    configuration: checkpoint.configuration,
    results: [...checkpoint.results].sort((left, right) => left.modelIndex - right.modelIndex),
  };
}

function checkpointDigest(checkpoint: StressCheckpoint): string {
  return sha256Node(JSON.stringify(checkpointPayload(checkpoint)));
}

function persistCheckpoint(path: string, checkpoint: StressCheckpoint): void {
  invariant(existsSync(dirname(path)), `checkpoint parent directory does not exist: ${dirname(path)}`);
  checkpoint.results.sort((left, right) => left.modelIndex - right.modelIndex);
  checkpoint.checkpointDigest = checkpointDigest(checkpoint);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx' });
  try {
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readCheckpoint(path: string): StressCheckpoint {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as StressCheckpoint;
  invariant(parsed?.format === 'partmode-cad-mutation-stress/v4', 'checkpoint format is unsupported');
  invariant(parsed.status === 'running' || parsed.status === 'ok', 'checkpoint status is invalid');
  invariant(Array.isArray(parsed.results), 'checkpoint results are invalid');
  invariant(/^[0-9a-f]{64}$/.test(parsed.checkpointDigest), 'checkpoint digest is missing');
  invariant(checkpointDigest(parsed) === parsed.checkpointDigest, 'checkpoint digest does not match its evidence');
  const indices = parsed.results.map((entry) => entry.modelIndex);
  invariant(new Set(indices).size === indices.length, 'checkpoint contains duplicate model results');
  return parsed;
}

function positiveInteger(value: string | undefined, label: string, allowZero = false): number {
  invariant(value !== undefined && /^\d+$/.test(value), `${label} must be an integer`);
  const parsed = Number(value);
  invariant(Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0), `${label} is outside the supported range`);
  return parsed;
}

function usage(): never {
  console.log(`Usage: node .build/scripts/cad-mutation-stress.js [options]

Deterministic Professional Core CAD mutation stress runner. With no arguments
it runs the exhaustive acceptance scale: 200 distinct models x 100 valid edits.

  --exhaustive              require at least 200 models x 100 cycles
  --focused                 run every structural family (8 models x 14 edits)
  --models N                override generated model count
  --cycles N                override valid edit cycles per model
  --invalid-every N         probe a missing persistent name every N cycles (0 disables)
  --progress-every N        browser progress interval in cycles
  --request-timeout-ms N    timeout for one exact worker rebuild (default 120000)
  --jobs N                  independent model lanes (default: 1 focused, up to 4 otherwise)
  --checkpoint PATH         atomically persist completed-model evidence
  --resume                  resume the exact same build/configuration checkpoint
  --seed N                  deterministic unsigned 32-bit seed
  --scenario-offset N       rotate the eight-family order for diagnostic replay
  --help                    show this text

Every valid edit is rebuilt twice: once in a persistent incremental worker and
once in a fresh cold worker. The two logically equivalent documents deliberately
use different independent feature/parameter array ordering.`);
  process.exit(0);
}

function parseOptions(argv: string[]): StressOptions {
  let focused = false;
  let exhaustive = false;
  let modelsOverride: number | undefined;
  let cyclesOverride: number | undefined;
  let invalidEveryOverride: number | undefined;
  let progressEveryOverride: number | undefined;
  let requestTimeoutMs = 120_000;
  let seed = 0x5eedc0de;
  let scenarioOffset = 0;
  let jobsOverride: number | undefined;
  let checkpointPath: string | undefined;
  let resume = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') usage();
    if (argument === '--focused') {
      focused = true;
      continue;
    }
    if (argument === '--exhaustive') {
      exhaustive = true;
      continue;
    }
    if (argument === '--resume') {
      resume = true;
      continue;
    }
    const next = argv[index + 1];
    if (argument === '--models') modelsOverride = positiveInteger(next, '--models');
    else if (argument === '--cycles') cyclesOverride = positiveInteger(next, '--cycles');
    else if (argument === '--invalid-every') invalidEveryOverride = positiveInteger(next, '--invalid-every', true);
    else if (argument === '--progress-every') progressEveryOverride = positiveInteger(next, '--progress-every');
    else if (argument === '--request-timeout-ms') requestTimeoutMs = positiveInteger(next, '--request-timeout-ms');
    else if (argument === '--jobs') jobsOverride = positiveInteger(next, '--jobs');
    else if (argument === '--checkpoint') {
      invariant(next !== undefined && next.length > 0 && !next.startsWith('-'), '--checkpoint requires a path');
      checkpointPath = resolve(next);
    } else if (argument === '--seed') {
      const parsed = positiveInteger(next, '--seed', true);
      invariant(parsed <= 0xffff_ffff, '--seed must fit in an unsigned 32-bit integer');
      seed = parsed >>> 0;
    } else if (argument === '--scenario-offset') {
      scenarioOffset = positiveInteger(next, '--scenario-offset', true);
      invariant(scenarioOffset < 8, '--scenario-offset must be between 0 and 7');
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
    index += 1;
  }

  invariant(!(focused && exhaustive), '--focused and --exhaustive are mutually exclusive');
  const models = modelsOverride ?? (focused ? 8 : 200);
  const cycles = cyclesOverride ?? (focused ? 14 : 100);
  const invalidEvery = invalidEveryOverride ?? (focused ? 7 : 20);
  const progressEvery = progressEveryOverride ?? (focused ? 7 : 10);
  if (exhaustive) {
    invariant(models >= 200 && cycles >= 100, '--exhaustive requires at least 200 models and 100 cycles');
  }
  invariant(models >= 8, 'mutation coverage requires at least one model for each of the 8 structural families');
  invariant(cycles >= 7, 'mutation coverage requires at least 7 edits so every registered-feature route executes');
  const custom = modelsOverride !== undefined || cyclesOverride !== undefined;
  const mode: StressOptions['mode'] = exhaustive
    ? 'exhaustive'
    : focused
      ? 'focused'
      : custom
        ? 'custom'
        : 'default-exhaustive';
  const professionalCoreAcceptance = models >= 200 && cycles >= 100;
  if (mode !== 'custom' || professionalCoreAcceptance) {
    invariant(
      invalidEvery > 0 && invalidEvery <= cycles,
      'focused and Professional Core acceptance require at least one invalid-reference probe per model',
    );
  }
  const defaultJobs = focused
    ? 1
    : Math.min(4, models, Math.max(1, Math.floor(availableParallelism() / 2)));
  const jobs = Math.min(models, jobsOverride ?? defaultJobs);
  invariant(!resume || checkpointPath !== undefined, '--resume requires --checkpoint PATH');
  return {
    mode,
    professionalCoreAcceptance,
    models,
    cycles,
    invalidEvery,
    progressEvery,
    requestTimeoutMs,
    seed,
    scenarioOffset,
    jobs,
    ...(checkpointPath ? { checkpointPath } : {}),
    resume,
  };
}

function rootPart(document: JsonDocument): JsonDocument {
  const part = (document.partDefinitions || []).find((entry: JsonDocument) => entry.id === document.rootDocument?.partId);
  invariant(part, 'root part is missing');
  return part;
}

function fixture(relativePath: string): JsonDocument {
  return JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), 'utf8')) as JsonDocument;
}

function valueBetween(minimum: number, maximum: number, fraction: number): number {
  return rounded(minimum + (maximum - minimum) * fraction);
}

let importedScenarioPromise: Promise<JsonDocument> | undefined;

async function importedScenarioDocument(): Promise<JsonDocument> {
  if (importedScenarioPromise) return clone(await importedScenarioPromise);
  importedScenarioPromise = (async () => {
    const priorUncaughtListeners = new Set(process.listeners('uncaughtException'));
    const priorRejectionListeners = new Set(process.listeners('unhandledRejection'));
    try {
    const vendorDirectory = resolve(repositoryRoot, 'src', 'static', 'vendor');
    const globals = globalThis as typeof globalThis & {
      require: ReturnType<typeof createRequire>;
      __dirname: string;
    };
    globals.require = createRequire(import.meta.url);
    globals.__dirname = vendorDirectory;
    const rc = await import(pathToFileURL(resolve(vendorDirectory, 'replicad.module.js')).href) as any;
    const ocFactory = await import(pathToFileURL(resolve(vendorDirectory, 'replicad-oc.module.js')).href) as any;
    const registryModule = await import(
      pathToFileURL(resolve(repositoryRoot, 'src', 'static', 'studio-imported-topology-registry.js')).href
    ) as any;
    const oc = await ocFactory.default({ locateFile: () => resolve(vendorDirectory, 'replicad_single.wasm') });
    rc.setOC(oc);
    const registry = registryModule.createStudioImportedTopologyRegistry(rc);
    const source = rc.makeBox([0, 0, 0], [11, 7, 5]);
    let captured: any;
    try {
      captured = registry.capture({ shape: source, registryId: 'resource-stress-imported' });
    } finally {
      source.delete();
    }
    const restored = registry.restore({
      sourceBrep: captured.sourceBrep,
      registry: captured.registry,
      expectedRegistryRef: captured.featureReference,
    });
    let filletEdgeName = '';
    try {
      invariant(restored.names.faces.length === 6, 'imported stress source did not preserve all six faces');
      invariant(restored.names.edges.length === 12, 'imported stress source did not preserve all twelve edges');
      invariant(restored.names.vertices.length === 8, 'imported stress source did not preserve all eight vertices');
      filletEdgeName = String(restored.names.edges[0]?.name || '');
      invariant(filletEdgeName.length > 0, 'imported stress source has no opaque fillet edge');
    } finally {
      registry.disposeOutcome(restored);
    }
    const document = {
      schemaVersion: 5,
      projectId: 'cad-mutation-imported',
      name: 'Imported STEP transform and fillet',
      units: 'mm',
      parameters: [
        { id: 'parameter-import-shift', name: 'import_shift', value: 3 },
        { id: 'parameter-import-fillet-r', name: 'import_fillet_r', value: 0.7 },
      ],
      materials: [],
      partDefinitions: [{
        id: 'part-imported-stress',
        name: 'Imported STEP transform and fillet',
        parameters: [],
        referenceGeometry: [],
        sketches: [],
        bodies: [{
          id: 'body-imported-step',
          name: 'Imported exact body',
          kind: 'solid',
          createdByFeatureId: 'feature-imported-step',
          featureIds: ['feature-imported-step', 'feature-imported-transform', 'feature-imported-fillet'],
          visible: true,
          suppressed: false,
        }],
        bodyPatterns: [],
        features: [{
          id: 'feature-imported-step',
          name: 'Imported exact body',
          type: 'imported-step',
          suppressed: false,
          inputRefs: [],
          resultPolicy: { kind: 'new-body', bodyName: 'Imported exact body' },
          createdBodyId: 'body-imported-step',
          extensions: {
            studioImportedStep: {
              resourceId: 'resource-stress-imported',
              exactBrep: true,
              parametricHistory: false,
              topologyRegistry: captured.featureReference,
            },
          },
        }, {
          id: 'feature-imported-transform',
          name: 'Move imported topology',
          type: 'transform',
          operation: 'move',
          transform: { mode: 'move', translation: ['import_shift', 0, 0] },
          sourceBodyId: 'body-imported-step',
          resultPolicy: { kind: 'add', targetBodyIds: ['body-imported-step'] },
          suppressed: false,
          inputRefs: [{
            ownerKind: 'body', ownerId: 'body-imported-step',
            semanticPath: { role: 'target' }, signature: { role: 'target' },
          }],
        }, {
          id: 'feature-imported-fillet',
          name: 'Fillet imported opaque edge',
          type: 'fillet',
          r: 'import_fillet_r',
          edges: [{ name: filletEdgeName }],
          variableRadii: [],
          resultPolicy: { kind: 'add', targetBodyIds: ['body-imported-step'] },
          suppressed: false,
          inputRefs: [{
            ownerKind: 'body', ownerId: 'body-imported-step',
            semanticPath: { role: 'target' }, signature: { role: 'target' },
          }],
        }],
        featureOrder: ['feature-imported-step', 'feature-imported-transform', 'feature-imported-fillet'],
        metadata: { activeBodyId: 'body-imported-step', importedFromStep: true },
        extensions: { studioImportedStep: { exactBrep: true, parametricHistory: false } },
      }],
      assemblyDefinitions: [],
      rootDocument: { kind: 'part', partId: 'part-imported-stress' },
      resources: [{
        id: 'resource-stress-imported',
        name: 'Imported exact body B-rep',
        mimeType: 'text/plain',
        byteLength: Buffer.byteLength(captured.sourceBrep, 'utf8'),
        encoding: 'base64',
        data: Buffer.from(captured.sourceBrep, 'utf8').toString('base64'),
        extensions: {
          studioImportedStep: {
            source: 'cad-mutation-stress',
            topologyRegistryByteLength: Buffer.byteLength(captured.registry.carrierBrep, 'utf8'),
            topologyRegistry: captured.registry,
          },
        },
      }],
      metadata: { corpus: 'cad-mutation-stress-imported' },
    };
      return document;
    } finally {
      // The Emscripten Node shim installs process-global exception listeners.
      // They are appropriate while initializing its WASM runtime but would
      // otherwise intercept later Puppeteer assertion failures and replace the
      // useful harness stack with a many-megabyte minified module line.
      for (const listener of process.listeners('uncaughtException')) {
        if (!priorUncaughtListeners.has(listener)) process.removeListener('uncaughtException', listener);
      }
      for (const listener of process.listeners('unhandledRejection')) {
        if (!priorRejectionListeners.has(listener)) process.removeListener('unhandledRejection', listener);
      }
    }
  })();
  return clone(await importedScenarioPromise);
}

let advancedScenarioPromise: Promise<JsonDocument> | undefined;

async function advancedScenarioDocument(): Promise<JsonDocument> {
  if (advancedScenarioPromise) return clone(await advancedScenarioPromise);
  advancedScenarioPromise = (async () => {
    const moduleAt = async (relativePath: string): Promise<any> => import(
      pathToFileURL(resolve(repositoryRoot, relativePath)).href
    );
    const [projectModule, runtime, agent, threadTools] = await Promise.all([
      moduleAt('src/static/studio-project-v5.js'),
      moduleAt('src/static/studio-v5-runtime-document.js'),
      moduleAt('src/static/studio-agent-service.js'),
      moduleAt('src/static/studio-thread.js'),
    ]);
    const rectangle = (
      id: string,
      x: number,
      y: number,
      width: number,
      height: number,
      z: number,
    ): JsonDocument => {
      const x0 = x - width / 2;
      const x1 = x + width / 2;
      const y0 = y - height / 2;
      const y1 = y + height / 2;
      return {
        entities: [
          { id: `${id}-bottom`, kind: 'line', a: [x0, y0], b: [x1, y0] },
          { id: `${id}-right`, kind: 'line', a: [x1, y0], b: [x1, y1] },
          { id: `${id}-top`, kind: 'line', a: [x1, y1], b: [x0, y1] },
          { id: `${id}-left`, kind: 'line', a: [x0, y1], b: [x0, y0] },
        ],
        shapes: [{ kind: 'rect', x, y, w: width, h: height }],
        z,
      };
    };
    const targetBodyId = 'body-advanced-direct';
    const threadBodyId = 'body-advanced-thread';
    const baseDocument: JsonDocument = {
      schemaVersion: 5,
      projectId: 'cad-mutation-advanced-features',
      name: 'CAD mutation advanced feature lifecycles',
      units: 'mm',
      parameters: [],
      materials: [],
      partDefinitions: [{
        id: 'part-cad-mutation-advanced',
        name: 'Advanced feature lifecycles',
        parameters: [],
        referenceGeometry: [],
        sketches: [],
        bodies: [
          {
            id: targetBodyId,
            name: 'Direct-edit target',
            kind: 'solid',
            createdByFeatureId: 'advanced-direct-base',
            featureIds: ['advanced-direct-base'],
            visible: true,
            suppressed: false,
          },
          {
            id: threadBodyId,
            name: 'Thread cylinder',
            kind: 'solid',
            createdByFeatureId: 'advanced-thread-cylinder',
            featureIds: ['advanced-thread-cylinder'],
            visible: true,
            suppressed: false,
          },
        ],
        bodyPatterns: [],
        features: [
          {
            id: 'advanced-direct-base',
            name: 'Direct-edit box',
            type: 'extrude',
            sketch: rectangle('advanced-direct-profile', -100, 0, 16, 12, 0),
            plane: { kind: 'base', plane: 'XY' },
            h: 8,
            through: false,
            resultPolicy: { kind: 'new-body', bodyName: 'Direct-edit target' },
            createdBodyId: targetBodyId,
            suppressed: false,
            inputRefs: [],
            extensions: { exactSketchEntities: true },
          },
          {
            id: 'advanced-thread-cylinder',
            name: 'M6 thread cylinder',
            type: 'extrude',
            sketch: {
              shapes: [{ id: 'advanced-thread-profile', kind: 'circle', x: 50, y: 0, r: 3 }],
              z: 0,
            },
            h: 3,
            through: false,
            resultPolicy: { kind: 'new-body', bodyName: 'Thread cylinder' },
            createdBodyId: threadBodyId,
            suppressed: false,
            inputRefs: [],
          },
        ],
        featureOrder: ['advanced-direct-base', 'advanced-thread-cylinder'],
        metadata: { activeBodyId: targetBodyId },
      }],
      assemblyDefinitions: [],
      rootDocument: { kind: 'part', partId: 'part-cad-mutation-advanced' },
      resources: [],
      metadata: { corpus: 'cad-mutation-advanced-features' },
    };
    let document = projectModule.prepareStudioV5Project(baseDocument) as JsonDocument;
    const transact = (transactionId: string, operations: JsonDocument[]): void => {
      document = agent.applyCadTransaction(document, {
        transactionId,
        label: transactionId,
        expectedRevision: 0,
        atomic: true,
        operations,
      }).project as JsonDocument;
    };
    transact('create-advanced-direct-edit', [{
      kind: 'directEdit.create',
      input: {
        id: 'advanced-direct-push',
        name: 'Push box top',
        operation: 'push-pull',
        targetBodyId,
        targetFace: {
          name: 'Fadvanced-direct-base:cap:end',
          sig: { p: [-100, 0, 8], n: [0, 0, 1], topologyKind: 'planar-face' },
        },
        distance: 2,
      },
    }]);
    const threadFeature = threadTools.createStudioThreadV2Feature({
      id: 'advanced-thread',
      name: 'Advanced modeled M6 thread',
      bodyId: threadBodyId,
      targetFace: {
        name: 'Fadvanced-thread-cylinder:side:inline-shape:advanced-thread-profile:circle',
        sig: {
          topologyKind: 'cylindrical-face',
          p: [50, 0, 1.5],
          n: [-3, 0, 0],
          a: [50, 0, 0],
          d: [0, 0, -1],
          r: 3,
        },
      },
      mode: 'modeled',
      threadKind: 'external',
      designation: 'M6',
      handedness: 'right',
      toleranceClass: '6g',
      span: { mode: 'fraction', start: 0, end: 1 },
      runout: 'full-profile',
    });
    transact('create-advanced-thread', [{
      kind: 'feature.thread',
      input: threadTools.studioThreadOperationInput(threadFeature),
    }]);
    const weldFaceName = (memberId: string, segment: string): string =>
      `F${memberId}:sweep:side:${memberId}-profile-sketch/entity-${memberId}-profile-sketch%3Asegment%3A${segment}`;
    const weldAOuterFace = weldFaceName('advanced-weld-a', '0%3A1');
    const weldAJointFace = weldFaceName('advanced-weld-a', '1%3A2');
    const weldBJointFace = weldFaceName('advanced-weld-b', '2%3A3');
    const weldBOuterFace = weldFaceName('advanced-weld-b', '0%3A3');
    transact('create-advanced-sheet-and-weldments', [
      {
        kind: 'datum.create',
        input: {
          id: 'advanced-sheet-plane',
          name: 'Advanced sheet plane',
          datumKind: 'plane',
          definition: {
            mode: 'principal',
            origin: [0, 0, 0],
            normal: [0, 0, 1],
            xDirection: [1, 0, 0],
          },
        },
      },
      {
        kind: 'sketch.profile.create',
        input: {
          id: 'advanced-sheet-profile',
          name: 'Advanced sheet profile',
          planeDatumId: 'advanced-sheet-plane',
          curveKind: 'polyline',
          points: [[100, 0], [140, 0], [140, 24], [100, 24]],
        },
      },
      {
        kind: 'sheetMetal.flange.create',
        input: {
          id: 'advanced-sheet-base',
          name: 'Advanced base flange',
          bodyName: 'Advanced sheet body',
          kind: 'base-flange',
          profileSketchId: 'advanced-sheet-profile',
          thickness: 2,
          kFactor: 0.44,
          bendRadius: 2,
        },
      },
      {
        kind: 'sheetMetal.flange.create',
        input: {
          id: 'advanced-sheet-edge',
          name: 'Advanced edge flange',
          kind: 'edge-flange',
          baseFeatureId: 'advanced-sheet-base',
          segmentIndex: 1,
          side: 'up',
          bendRadius: 2,
          kFactor: 0.44,
          flangeLength: 12,
        },
      },
      {
        kind: 'sketch.path.create',
        input: {
          id: 'advanced-treatment-path',
          name: 'Treatment member path',
          curveKind: 'polyline',
          points: [[-220, -100, 0], [-120, -100, 0]],
        },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: 'advanced-treatment-member',
          name: 'Treatment member',
          pathSketchId: 'advanced-treatment-path',
          familyId: 'rectangular-bar',
          presetId: 'rect-20x10',
        },
      },
      {
        kind: 'structural.treatment.create',
        input: {
          id: 'advanced-treatment',
          name: 'Advanced trim',
          kind: 'trim-extend',
          memberId: 'advanced-treatment-member',
          end: 'start',
          mode: 'trim',
          distance: 6,
        },
      },
      {
        kind: 'sketch.path.create',
        input: {
          id: 'advanced-weld-path-a',
          name: 'Weld support A path',
          curveKind: 'polyline',
          points: [[0, 0, 0], [0, 0, 100]],
        },
      },
      {
        kind: 'sketch.path.create',
        input: {
          id: 'advanced-weld-path-b',
          name: 'Weld support B path',
          curveKind: 'polyline',
          points: [[0, 0, 0], [0, 0, 100]],
        },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: 'advanced-weld-a',
          name: 'Weld support A',
          pathSketchId: 'advanced-weld-path-a',
          familyId: 'rectangular-bar',
          presetId: 'rect-20x10',
          placement: { anchor: 'center', rotationDegrees: 0, offset: [0, 0] },
        },
      },
      {
        kind: 'structural.member.create',
        input: {
          id: 'advanced-weld-b',
          name: 'Weld support B',
          pathSketchId: 'advanced-weld-path-b',
          familyId: 'rectangular-bar',
          presetId: 'rect-20x10',
          placement: { anchor: 'center', rotationDegrees: 0, offset: [20, -10] },
        },
      },
      {
        kind: 'weld.bead.create',
        input: {
          id: 'advanced-weld-bead',
          name: 'Advanced fillet weld',
          bodyName: 'Advanced weld bead',
          kind: 'fillet',
          sizeMm: 3,
          process: 'GMAW',
          supports: [
            {
              role: 'support-a',
              memberId: 'advanced-weld-a',
              face: {
                name: weldAJointFace,
                sig: { p: [0, 10, 50], n: [0, 1, 0], topologyKind: 'planar-face' },
              },
              edge: {
                name: `E(${weldAOuterFace}|${weldAJointFace})`,
                sig: { p: [5, 10, 50], l: 100, curveType: 'LINE' },
              },
            },
            {
              role: 'support-b',
              memberId: 'advanced-weld-b',
              face: {
                name: weldBJointFace,
                sig: { p: [5, 20, 50], n: [-1, 0, 0], topologyKind: 'planar-face' },
              },
              edge: {
                name: `E(${weldBOuterFace}|${weldBJointFace})`,
                sig: { p: [5, 10, 50], l: 100, curveType: 'LINE' },
              },
            },
          ],
        },
      },
    ]);
    return projectModule.prepareStudioV5Project(document) as JsonDocument;
  })();
  return clone(await advancedScenarioPromise);
}

async function scenarioDefinitions(): Promise<ScenarioDefinition[]> {
  const booleanCut = fixture('tests/cad-corpus/boolean-cut.partmode.json');
  const filletShell = fixture('tests/cad-corpus/fillet-shell.partmode.json');
  const loft = fixture('tests/cad-corpus/loft-sections.partmode.json');
  const sweep = fixture('tests/cad-corpus/sweep-path.partmode.json');
  const profileCut = fixture('tests/cad-corpus/profile-pattern.partmode.json');
  const registered = fixture('tests/feature-registry-runtime/registered-features.partmode.json');
  const imported = await importedScenarioDocument();
  const advanced = await advancedScenarioDocument();
  const independentBooleanTool = rootPart(booleanCut).features.find((feature: JsonDocument) => feature.id === 'feature-tool-extrude');
  invariant(independentBooleanTool, 'Boolean scenario tool feature is missing');
  independentBooleanTool.h = 36;
  const set = (name: string, minimum: number, maximum: number) =>
    (document: JsonDocument, fraction: number) => setProjectParameter(document, name, valueBetween(minimum, maximum, fraction));
  return [
    {
      id: 'boolean-history',
      source: 'tests/cad-corpus/boolean-cut.partmode.json',
      document: booleanCut,
      meaningfulFeatureTypes: ['boolean', 'extrude'],
      routes: [{
        id: 'boolean-tool-radius', editedFeatureTypes: ['boolean', 'extrude'],
        evaluatedFeatureIds: ['feature-tool-extrude', 'feature-tool-subtract'],
        changedBodyIds: ['body-boolean-target', 'body-boolean-tool'],
        apply: set('tool_r', 4.5, 8.5),
      }, {
        id: 'boolean-upstream-height', editedFeatureTypes: ['boolean', 'extrude'],
        evaluatedFeatureIds: ['feature-target-extrude', 'feature-tool-subtract'],
        changedBodyIds: ['body-boolean-target'],
        apply: set('base_h', 16, 28),
      }],
    },
    {
      id: 'fillet-shell-modifiers',
      source: 'tests/cad-corpus/fillet-shell.partmode.json',
      document: filletShell,
      meaningfulFeatureTypes: ['extrude', 'fillet', 'shell'],
      routes: [{
        id: 'fillet-radius', editedFeatureTypes: ['fillet'], evaluatedFeatureIds: ['feature-edge-fillet'],
        changedBodyIds: ['body-fillet-box'], apply: set('fillet_r', 1, 3.4),
      }, {
        id: 'shell-thickness', editedFeatureTypes: ['shell'], evaluatedFeatureIds: ['feature-open-shell'],
        changedBodyIds: ['body-shell-box'], apply: set('shell_t', 0.75, 2.1),
      }],
    },
    {
      id: 'loft-sections',
      source: 'tests/cad-corpus/loft-sections.partmode.json',
      document: loft,
      meaningfulFeatureTypes: ['loft'],
      routes: [{
        id: 'loft-height', editedFeatureTypes: ['loft'], evaluatedFeatureIds: ['feature-loft-sections'],
        changedBodyIds: ['body-loft-sections'], apply: set('loft_height', 30, 52),
      }, {
        id: 'loft-mid-width', editedFeatureTypes: ['loft'], evaluatedFeatureIds: ['feature-loft-sections'],
        changedBodyIds: ['body-loft-sections'], apply: set('mid_half_w', 9, 15),
      }, {
        id: 'loft-tip-width', editedFeatureTypes: ['loft'], evaluatedFeatureIds: ['feature-loft-sections'],
        changedBodyIds: ['body-loft-sections'], apply: set('tip_half_w', 5, 9),
      }],
    },
    {
      id: 'sweep-path',
      source: 'tests/cad-corpus/sweep-path.partmode.json',
      document: sweep,
      meaningfulFeatureTypes: ['sweep'],
      routes: [{
        id: 'sweep-scale', editedFeatureTypes: ['sweep'], evaluatedFeatureIds: ['feature-sweep-path'],
        changedBodyIds: ['body-sweep-path'], apply: set('sweep_scale', 0.62, 1.15),
      }, {
        id: 'sweep-offset', editedFeatureTypes: ['sweep'], evaluatedFeatureIds: ['feature-sweep-path'],
        changedBodyIds: ['body-sweep-path'], apply: set('path_offset', 9, 18),
      }, {
        id: 'sweep-upstream-path', editedFeatureTypes: ['sweep'], evaluatedFeatureIds: ['feature-sweep-path'],
        changedBodyIds: ['body-sweep-path'],
        apply: (document, fraction) => {
          const bend = valueBetween(14, 23, fraction);
          setProjectParameter(document, 'path_bend_height', bend);
          setProjectParameter(document, 'path_height', rounded(bend + valueBetween(15, 25, 1 - fraction)));
        },
      }],
    },
    {
      id: 'profile-cut-pattern',
      source: 'tests/cad-corpus/profile-pattern.partmode.json',
      document: profileCut,
      meaningfulFeatureTypes: ['cut', 'extrude'],
      routes: [{
        id: 'cut-pattern-spacing', editedFeatureTypes: ['cut'], evaluatedFeatureIds: ['feature-pattern-cut'],
        changedBodyIds: ['body-profile-pattern'], apply: set('pattern_spacing', 13, 18),
      }, {
        id: 'cut-upstream-height', editedFeatureTypes: ['cut', 'extrude'],
        evaluatedFeatureIds: ['feature-pattern-stock', 'feature-pattern-cut'],
        changedBodyIds: ['body-profile-pattern'], apply: set('pattern_height', 7, 15),
      }],
    },
    {
      id: 'registered-contexts',
      source: 'tests/feature-registry-runtime/registered-features.partmode.json',
      document: registered,
      meaningfulFeatureTypes: ['boolean-split-side', 'chamfer', 'cut', 'draft', 'extrude', 'revolve', 'thicken', 'transform'],
      routes: [{
        id: 'chamfer-size', editedFeatureTypes: ['chamfer'], evaluatedFeatureIds: ['feature-chamfer'],
        changedBodyIds: ['body-chamfer'], apply: set('chamfer_size', 0.8, 2.8),
      }, {
        id: 'draft-angle', editedFeatureTypes: ['draft'], evaluatedFeatureIds: ['feature-draft'],
        changedBodyIds: ['body-draft'], apply: set('draft_angle', 2, 7),
      }, {
        id: 'revolve-angle', editedFeatureTypes: ['revolve'], evaluatedFeatureIds: ['feature-revolve'],
        changedBodyIds: ['body-revolve'], apply: set('revolve_angle', 210, 330),
      }, {
        id: 'thicken-distance', editedFeatureTypes: ['thicken'], evaluatedFeatureIds: ['feature-thicken'],
        changedBodyIds: ['body-thickened'], apply: set('thicken_distance', 1, 3.5),
      }, {
        id: 'transform-distance', editedFeatureTypes: ['transform'], evaluatedFeatureIds: ['feature-transform-copy'],
        changedBodyIds: ['body-transform-copy'], apply: set('transform_dx', 27, 42),
      }, {
        id: 'split-upstream-height', editedFeatureTypes: ['boolean-split-side', 'extrude'],
        evaluatedFeatureIds: ['feature-split-target', 'feature-split-outside', 'feature-split-inside'],
        changedBodyIds: ['body-split-target', 'body-split-outside', 'body-split-inside'],
        // The split tool spans z=-4..16. Keep the target cap strictly inside
        // that interval so this route varies geometry without changing the
        // intended Boolean topology regime.
        apply: set('split_target_height', 9, 15),
      }, {
        id: 'face-cut-upstream-height', editedFeatureTypes: ['cut', 'extrude'],
        evaluatedFeatureIds: ['feature-face-stock', 'feature-face-cut'],
        changedBodyIds: ['body-face-attached'], apply: set('face_stock_height', 8, 16),
      }],
    },
    {
      id: 'imported-transform-fillet',
      source: 'dynamic registry-backed OCCT box',
      document: imported,
      meaningfulFeatureTypes: ['fillet', 'imported-step', 'transform'],
      routes: [{
        id: 'import-upstream-transform', editedFeatureTypes: ['fillet', 'transform'],
        evaluatedFeatureIds: ['feature-imported-transform', 'feature-imported-fillet'],
        changedBodyIds: ['body-imported-step'], apply: set('import_shift', 1, 8),
      }, {
        id: 'import-downstream-fillet', editedFeatureTypes: ['fillet'],
        evaluatedFeatureIds: ['feature-imported-fillet'],
        changedBodyIds: ['body-imported-step'], apply: set('import_fillet_r', 0.35, 1.2),
      }],
    },
    {
      id: 'advanced-feature-lifecycles',
      source: 'typed direct-edit, thread, sheet-metal, weld-bead, and weldment-treatment lifecycles',
      document: advanced,
      meaningfulFeatureTypes: [
        'direct-edit',
        'extrude',
        'sheet-metal-flange',
        'sweep',
        'thread',
        'weld-bead',
        'weldment-treatment',
      ],
      routes: [{
        id: 'advanced-direct-distance',
        editedFeatureTypes: ['direct-edit'],
        evaluatedFeatureIds: ['advanced-direct-push'],
        changedBodyIds: ['body-advanced-direct'],
        apply: (document, fraction) => {
          const feature = rootPart(document).features.find((entry: JsonDocument) =>
            entry.id === 'advanced-direct-push');
          invariant(feature, 'advanced direct-edit feature is missing');
          const value = valueBetween(1, 3.5, fraction);
          feature.distance = Object.is(Number(feature.distance), value) ? rounded(value + 0.001) : value;
        },
      }, {
        id: 'advanced-thread-span',
        editedFeatureTypes: ['thread'],
        evaluatedFeatureIds: ['advanced-thread'],
        changedBodyIds: ['body-advanced-thread'],
        topologyChangeBodyIds: ['body-advanced-thread'],
        apply: (document, fraction) => {
          const feature = rootPart(document).features.find((entry: JsonDocument) =>
            entry.id === 'advanced-thread');
          invariant(feature?.extensions?.thread?.span?.mode === 'fraction', 'advanced Thread feature is missing');
          const value = valueBetween(0.7, 1, fraction);
          const current = Number(feature.extensions.thread.span.end);
          feature.extensions.thread.span.end = Object.is(current, value) ? rounded(Math.max(0.7, value - 0.001)) : value;
        },
      }, {
        id: 'advanced-sheet-flange-length',
        editedFeatureTypes: ['sheet-metal-flange'],
        evaluatedFeatureIds: ['advanced-sheet-edge'],
        changedBodyIds: ['body-advanced-sheet-base'],
        apply: (document, fraction) => {
          const feature = rootPart(document).features.find((entry: JsonDocument) =>
            entry.id === 'advanced-sheet-edge');
          invariant(feature?.extensions?.sheetMetal, 'advanced sheet-metal edge flange is missing');
          const value = valueBetween(8, 18, fraction);
          const current = Number(feature.extensions.sheetMetal.flangeLength);
          feature.extensions.sheetMetal.flangeLength = Object.is(current, value) ? rounded(value + 0.001) : value;
        },
      }, {
        id: 'advanced-weld-size',
        editedFeatureTypes: ['weld-bead'],
        evaluatedFeatureIds: ['advanced-weld-bead'],
        changedBodyIds: ['body-advanced-weld-bead'],
        apply: (document, fraction) => {
          const feature = rootPart(document).features.find((entry: JsonDocument) =>
            entry.id === 'advanced-weld-bead');
          invariant(feature?.extensions?.weldBead, 'advanced weld-bead feature is missing');
          const value = valueBetween(1.5, 4.5, fraction);
          const current = Number(feature.extensions.weldBead.sizeMm);
          feature.extensions.weldBead.sizeMm = Object.is(current, value) ? rounded(value + 0.001) : value;
        },
      }, {
        id: 'advanced-treatment-distance',
        editedFeatureTypes: ['weldment-treatment'],
        evaluatedFeatureIds: ['advanced-treatment'],
        changedBodyIds: ['body-advanced-treatment-member'],
        apply: (document, fraction) => {
          const feature = rootPart(document).features.find((entry: JsonDocument) =>
            entry.id === 'advanced-treatment');
          invariant(feature?.extensions?.weldmentTreatment, 'advanced weldment-treatment feature is missing');
          const value = valueBetween(3, 12, fraction);
          const current = Number(feature.extensions.weldmentTreatment.distance);
          feature.extensions.weldmentTreatment.distance = Object.is(current, value) ? rounded(value + 0.001) : value;
        },
      }],
    },
  ];
}

function modelIds(index: number, partId: string): ModelIds {
  const suffix = String(index + 1).padStart(3, '0');
  const stockFeatureId = `feature-stress-${suffix}-stock`;
  const filletFeatureId = `feature-stress-${suffix}-fillet`;
  const stockLine2Id = `stress-${suffix}-stock-line-2`;
  const selectedEdgeName = `E(F${stockFeatureId}:cap:end|F${stockFeatureId}:side:${stockLine2Id})`;
  return {
    partId,
    stockBodyId: `body-stress-${suffix}-stock`,
    witnessBodyId: `body-stress-${suffix}-witness`,
    stockFeatureId,
    filletFeatureId,
    witnessFeatureId: `feature-stress-${suffix}-witness`,
    stockLine2Id,
    selectedEdgeName,
    invalidEdgeName: `E(F${stockFeatureId}:missing-cap|F${stockFeatureId}:missing-side)`,
  };
}

function makeStressModel(index: number, scenario: ScenarioDefinition): {
  id: string;
  scenarioId: string;
  scenarioSource: string;
  meaningfulFeatureTypes: string[];
  routes: MutationRoute[];
  ids: ModelIds;
  document: JsonDocument;
  requiredNameKeys: string[];
} {
  const suffix = String(index + 1).padStart(3, '0');
  const document = clone(scenario.document);
  const part = rootPart(document);
  part.id = `part-stress-${suffix}`;
  document.rootDocument.partId = part.id;
  const ids = modelIds(index, part.id);
  const plane = ['XY', 'YZ', 'ZX'][index % 3];
  const stockWidth = rounded(18 + (index % 17) * 0.31);
  const stockDepth = rounded(10 + (index % 13) * 0.23);
  const stockHeight = rounded(8 + index * 0.013);
  const filletRadius = rounded(0.55 + (index % 11) * 0.037);
  const witnessWidth = rounded(7 + (index % 19) * 0.17);
  const witnessDepth = rounded(6 + (index % 23) * 0.11);
  const witnessHeight = rounded(5 + index * 0.007);
  const witnessOffset = rounded(70 + (index % 29) * 0.29);
  const stockLine1Id = `stress-${suffix}-stock-line-1`;
  const stockLine3Id = `stress-${suffix}-stock-line-3`;
  const stockLine4Id = `stress-${suffix}-stock-line-4`;
  const witnessLine1Id = `stress-${suffix}-witness-line-1`;
  const witnessLine2Id = `stress-${suffix}-witness-line-2`;
  const witnessLine3Id = `stress-${suffix}-witness-line-3`;
  const witnessLine4Id = `stress-${suffix}-witness-line-4`;
  const witnessCapName = `F${ids.witnessFeatureId}:cap:start`;
  const stockCapName = `F${ids.stockFeatureId}:cap:start`;
  const blendName = `F${ids.filletFeatureId}:blend:${ids.selectedEdgeName}`;

  document.projectId = `cad-mutation-stress-${suffix}`;
  document.name = `CAD mutation stress ${suffix}: ${scenario.id}`;
  document.parameters.push(
    { id: `param-${suffix}-stock-h`, name: `stress_${suffix}_stock_h`, value: stockHeight },
    { id: `param-${suffix}-fillet-r`, name: `stress_${suffix}_fillet_r`, value: filletRadius },
    { id: `param-${suffix}-witness-h`, name: `stress_${suffix}_witness_h`, value: witnessHeight },
    { id: `param-${suffix}-witness-offset`, name: `stress_${suffix}_witness_offset`, value: witnessOffset },
  );
  part.bodies.push(
          {
            id: ids.stockBodyId,
            name: 'Named stock',
            kind: 'solid',
            createdByFeatureId: ids.stockFeatureId,
            featureIds: [ids.stockFeatureId, ids.filletFeatureId],
            visible: true,
            suppressed: false,
          },
          {
            id: ids.witnessBodyId,
            name: 'Independent witness',
            kind: 'solid',
            createdByFeatureId: ids.witnessFeatureId,
            featureIds: [ids.witnessFeatureId],
            visible: true,
            suppressed: false,
          },
  );
  part.features.push(
          {
            id: ids.stockFeatureId,
            name: 'Exact named stock',
            type: 'extrude',
            sketch: {
              id: `sketch-stress-${suffix}-stock`,
              name: 'Stock profile',
              entities: [
                { id: stockLine1Id, kind: 'line', a: [-stockWidth / 2, -stockDepth / 2], b: [stockWidth / 2, -stockDepth / 2] },
                { id: ids.stockLine2Id, kind: 'line', a: [stockWidth / 2, -stockDepth / 2], b: [stockWidth / 2, stockDepth / 2] },
                { id: stockLine3Id, kind: 'line', a: [stockWidth / 2, stockDepth / 2], b: [-stockWidth / 2, stockDepth / 2] },
                { id: stockLine4Id, kind: 'line', a: [-stockWidth / 2, stockDepth / 2], b: [-stockWidth / 2, -stockDepth / 2] },
              ],
              groups: [],
              constraints: [],
              shapes: [{ kind: 'rect', x: 0, y: 0, w: stockWidth, h: stockDepth }],
              z: 0,
            },
            plane: { kind: 'base', plane },
            h: `stress_${suffix}_stock_h`,
            through: false,
            resultPolicy: { kind: 'new-body', bodyName: 'Named stock' },
            createdBodyId: ids.stockBodyId,
            suppressed: false,
            inputRefs: [],
            extensions: { exactSketchEntities: true },
          },
          {
            id: ids.filletFeatureId,
            name: 'Persistent-name fillet',
            type: 'fillet',
            r: `stress_${suffix}_fillet_r`,
            edges: [
              {
                name: ids.selectedEdgeName,
                sig: { p: [0, 0, 0], l: stockHeight, curveType: 'LINE' },
              },
            ],
            resultPolicy: { kind: 'add', targetBodyIds: [ids.stockBodyId] },
            suppressed: false,
            inputRefs: [
              {
                ownerKind: 'body',
                ownerId: ids.stockBodyId,
                semanticPath: { role: 'target' },
                signature: { role: 'target' },
              },
            ],
          },
          {
            id: ids.witnessFeatureId,
            name: 'Independent exact witness',
            type: 'extrude',
            sketch: {
              id: `sketch-stress-${suffix}-witness`,
              name: 'Witness profile',
              entities: [
                { id: witnessLine1Id, kind: 'line', a: [-witnessWidth / 2, -witnessDepth / 2], b: [witnessWidth / 2, -witnessDepth / 2] },
                { id: witnessLine2Id, kind: 'line', a: [witnessWidth / 2, -witnessDepth / 2], b: [witnessWidth / 2, witnessDepth / 2] },
                { id: witnessLine3Id, kind: 'line', a: [witnessWidth / 2, witnessDepth / 2], b: [-witnessWidth / 2, witnessDepth / 2] },
                { id: witnessLine4Id, kind: 'line', a: [-witnessWidth / 2, witnessDepth / 2], b: [-witnessWidth / 2, -witnessDepth / 2] },
              ],
              groups: [],
              constraints: [],
              shapes: [{ kind: 'rect', x: 0, y: 0, w: witnessWidth, h: witnessDepth }],
              z: `stress_${suffix}_witness_offset`,
            },
            plane: { kind: 'base', plane },
            h: `stress_${suffix}_witness_h`,
            through: false,
            resultPolicy: { kind: 'new-body', bodyName: 'Independent witness' },
            createdBodyId: ids.witnessBodyId,
            suppressed: false,
            inputRefs: [],
            extensions: { exactSketchEntities: true },
          },
  );
  part.featureOrder.push(ids.stockFeatureId, ids.filletFeatureId, ids.witnessFeatureId);
  part.metadata = { ...(part.metadata || {}), activeBodyId: ids.stockBodyId };
  document.metadata = {
    ...(document.metadata || {}),
    corpus: 'cad-mutation-stress',
    modelIndex: index,
    scenarioId: scenario.id,
    scenarioSource: scenario.source,
  };

  return {
    id: `stress-${suffix}`,
    scenarioId: scenario.id,
    scenarioSource: scenario.source,
    meaningfulFeatureTypes: [...scenario.meaningfulFeatureTypes].sort(),
    routes: scenario.routes,
    ids,
    document,
    requiredNameKeys: [
      `${ids.stockBodyId}/face/${stockCapName}`,
      `${ids.stockBodyId}/face/${blendName}`,
      `${ids.witnessBodyId}/face/${witnessCapName}`,
    ],
  };
}

function setProjectParameter(document: JsonDocument, name: string, value: number): void {
  const matches = (document.parameters as JsonDocument[]).filter((parameter) => parameter.name === name);
  invariant(matches.length === 1, `parameter ${name} did not resolve exactly once`);
  const parameter = matches[0];
  invariant(parameter, `parameter ${name} is unavailable`);
  const current = Number(parameter.value);
  // A rounded PRNG value can occasionally land on the current value. Every
  // numbered cycle is an actual edit, so deterministically nudge that rare
  // collision instead of accepting a cache no-op as stress coverage.
  parameter.value = Object.is(current, value) ? rounded(value + 0.001) : value;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function applyDeterministicEdit(
  document: JsonDocument,
  routes: MutationRoute[],
  allFeatureIds: string[],
  allBodyIds: string[],
  cycle: number,
  random: () => number,
): MutationExpectation {
  const route = routes[(cycle - 1) % routes.length];
  invariant(route, `cycle ${cycle} has no deterministic mutation route`);
  route.apply(document, random());
  const evaluated = new Set(route.evaluatedFeatureIds);
  const changed = new Set(route.changedBodyIds);
  const topologyChanges = new Set(route.topologyChangeBodyIds || []);
  invariant(evaluated.size === route.evaluatedFeatureIds.length, `${route.id}: duplicate evaluated feature`);
  invariant(changed.size === route.changedBodyIds.length, `${route.id}: duplicate changed body`);
  for (const featureId of evaluated) invariant(allFeatureIds.includes(featureId), `${route.id}: unknown evaluated feature ${featureId}`);
  for (const bodyId of changed) invariant(allBodyIds.includes(bodyId), `${route.id}: unknown changed body ${bodyId}`);
  for (const bodyId of topologyChanges) {
    invariant(changed.has(bodyId), `${route.id}: topology-changing body ${bodyId} is not declared changed`);
  }
  return {
    routeId: route.id,
    editedFeatureTypes: [...route.editedFeatureTypes].sort(),
    evaluatedFeatureIds: [...evaluated],
    reusedFeatureIds: allFeatureIds.filter((featureId) => !evaluated.has(featureId)),
    changedBodyIds: [...changed],
    unchangedBodyIds: allBodyIds.filter((bodyId) => !changed.has(bodyId)),
    topologyChangeBodyIds: [...topologyChanges],
  };
}

function orderedAndShuffled(document: JsonDocument): { ordered: JsonDocument; shuffled: JsonDocument } {
  const ordered = clone(document);
  const shuffled = clone(document);
  const orderedPart = rootPart(ordered);
  const shuffledPart = rootPart(shuffled);
  const byId = new Map<string, JsonDocument>(
    (orderedPart.features as JsonDocument[]).map((feature) => [String(feature.id), feature]),
  );
  orderedPart.features = orderedPart.featureOrder.map((featureId: string) => {
    const feature = byId.get(featureId);
    invariant(feature, `ordered feature ${featureId} is missing`);
    return feature;
  });
  const shuffledById = new Map<string, JsonDocument>(
    (shuffledPart.features as JsonDocument[]).map((feature) => [String(feature.id), feature]),
  );
  shuffledPart.features = [...(shuffledPart.featureOrder as string[])].reverse().map((featureId) => {
    const feature = shuffledById.get(featureId);
    invariant(feature, `shuffled feature ${featureId} is missing`);
    return feature;
  });
  shuffled.parameters = [...(shuffled.parameters as JsonDocument[])].reverse();
  shuffledPart.referenceGeometry = [...(shuffledPart.referenceGeometry || [])].reverse();
  shuffledPart.sketches = [...(shuffledPart.sketches || [])].reverse();
  shuffled.resources = [...(shuffled.resources || [])].reverse();
  return { ordered, shuffled };
}

function prepareRoundTrip(document: JsonDocument, api: SchemaApi, label: string): { document: JsonDocument; hash: string } {
  const sourceSnapshot = JSON.stringify(document);
  const prepared = api.prepareStudioV5Project(clone(document));
  invariant(JSON.stringify(document) === sourceSnapshot, `${label}: schema preparation mutated its input`);
  const preparedAgain = api.prepareStudioV5Project(clone(prepared));
  invariant(JSON.stringify(preparedAgain) === JSON.stringify(prepared), `${label}: schema preparation is not idempotent`);
  const saved = JSON.stringify(prepared);
  const reopened = api.parseStudioV5Project(saved);
  invariant(JSON.stringify(reopened) === saved, `${label}: save/reopen JSON round-trip changed the document`);
  const hash = api.studioV5CanonicalHash(reopened);
  invariant(/^[0-9a-f]{64}$/.test(hash), `${label}: canonical hash is not SHA-256`);
  invariant(api.studioV5CanonicalHash(api.parseStudioV5Project(JSON.stringify(reopened))) === hash, `${label}: reopened canonical hash is unstable`);
  return { document: reopened, hash };
}

function preparePair(
  rawDocument: JsonDocument,
  api: SchemaApi,
  label: string,
  flip: boolean,
): PreparedPair {
  const pair = orderedAndShuffled(rawDocument);
  const ordered = prepareRoundTrip(pair.ordered, api, `${label}/ordered`);
  const shuffled = prepareRoundTrip(pair.shuffled, api, `${label}/shuffled`);
  const orderedPart = rootPart(ordered.document);
  const shuffledPart = rootPart(shuffled.document);
  invariant(
    JSON.stringify(orderedPart.featureOrder) === JSON.stringify(shuffledPart.featureOrder),
    `${label}: logical feature order changed while shuffling independent inputs`,
  );
  invariant(
    orderedPart.features[0]?.id === orderedPart.featureOrder[0]
      && shuffledPart.features[0]?.id === shuffledPart.featureOrder.at(-1)
      && orderedPart.features[0]?.id !== shuffledPart.features[0]?.id,
    `${label}: feature-record input ordering was not actually shuffled`,
  );
  invariant(ordered.hash !== shuffled.hash, `${label}: shuffled record arrays did not change canonical document evidence`);
  return {
    incrementalDocument: flip ? shuffled.document : ordered.document,
    coldDocument: flip ? ordered.document : shuffled.document,
    orderedHash: ordered.hash,
    shuffledHash: shuffled.hash,
  };
}

async function schemaApi(): Promise<SchemaApi> {
  const projectModule = await import(pathToFileURL(resolve(repositoryRoot, 'src', 'static', 'studio-project-v5.js')).href);
  const runtimeModule = await import(pathToFileURL(resolve(repositoryRoot, 'src', 'static', 'studio-v5-runtime-document.js')).href);
  const featureTypeModule = await import(pathToFileURL(resolve(repositoryRoot, 'src', 'static', 'studio-v5-feature-types.js')).href);
  return {
    prepareStudioV5Project: projectModule.prepareStudioV5Project as SchemaApi['prepareStudioV5Project'],
    parseStudioV5Project: projectModule.parseStudioV5Project as SchemaApi['parseStudioV5Project'],
    studioV5CanonicalHash: runtimeModule.studioV5CanonicalHash as SchemaApi['studioV5CanonicalHash'],
    featureTypes: [...featureTypeModule.STUDIO_V5_FEATURE_TYPES] as string[],
  };
}

async function prepareModel(
  index: number,
  options: StressOptions,
  api: SchemaApi,
  scenarios: ScenarioDefinition[],
): Promise<PreparedModel> {
  const scenario = scenarios[(index + options.scenarioOffset) % scenarios.length];
  invariant(scenario, `model ${index} has no structural scenario`);
  const generated = makeStressModel(index, scenario);
  const random = mulberry32((options.seed ^ Math.imul(index + 1, 0x9e37_79b1)) >>> 0);
  const working = clone(generated.document);
  for (const route of generated.routes) route.apply(working, random());
  const part = rootPart(working);
  const allFeatureIds = [...(part.featureOrder as string[])];
  const allBodyIds = (part.bodies as JsonDocument[]).map((body) => String(body.id));
  invariant(new Set(allFeatureIds).size === allFeatureIds.length, `${generated.id}: duplicate feature order IDs`);
  invariant(new Set(allBodyIds).size === allBodyIds.length, `${generated.id}: duplicate body IDs`);
  const actualFeatureTypes = new Set<string>((part.features as JsonDocument[]).map((feature) => String(feature.type)));
  for (const type of generated.meaningfulFeatureTypes) {
    invariant(api.featureTypes.includes(type), `${generated.id}: scenario declares unregistered type ${type}`);
    invariant(actualFeatureTypes.has(type), `${generated.id}: scenario does not contain declared type ${type}`);
  }
  for (const route of generated.routes) {
    invariant(route.editedFeatureTypes.length > 0, `${generated.id}/${route.id}: route has no type coverage`);
    for (const type of route.editedFeatureTypes) {
      invariant(generated.meaningfulFeatureTypes.includes(type), `${generated.id}/${route.id}: undeclared edited type ${type}`);
    }
  }
  const baseline = preparePair(working, api, `${generated.id}/baseline`, false);
  const cycles: PreparedCycle[] = [];
  for (let cycle = 1; cycle <= options.cycles; cycle += 1) {
    const expectation = applyDeterministicEdit(
      working,
      generated.routes,
      allFeatureIds,
      allBodyIds,
      cycle,
      random,
    );
    const pair = preparePair(working, api, `${generated.id}/cycle-${cycle}`, cycle % 2 === 0);
    cycles.push({
      ...pair,
      cycle,
      expectation,
      runInvalidProbe: options.invalidEvery > 0 && cycle % options.invalidEvery === 0,
    });
  }
  return {
    id: generated.id,
    scenarioId: generated.scenarioId,
    scenarioSource: generated.scenarioSource,
    meaningfulFeatureTypes: generated.meaningfulFeatureTypes,
    allFeatureIds,
    allBodyIds,
    ids: generated.ids,
    requiredNameKeys: generated.requiredNameKeys,
    baseline,
    cycles,
  };
}

function preparedModelDigest(model: PreparedModel): string {
  return sha256Node(JSON.stringify({
    id: model.id,
    scenarioId: model.scenarioId,
    scenarioSource: model.scenarioSource,
    meaningfulFeatureTypes: model.meaningfulFeatureTypes,
    allFeatureIds: model.allFeatureIds,
    allBodyIds: model.allBodyIds,
    ids: model.ids,
    requiredNameKeys: model.requiredNameKeys,
    baseline: {
      orderedHash: model.baseline.orderedHash,
      shuffledHash: model.baseline.shuffledHash,
      incrementalDocumentDigest: sha256Node(JSON.stringify(model.baseline.incrementalDocument)),
      coldDocumentDigest: sha256Node(JSON.stringify(model.baseline.coldDocument)),
    },
    cycles: model.cycles.map((cycle) => ({
      cycle: cycle.cycle,
      orderedHash: cycle.orderedHash,
      shuffledHash: cycle.shuffledHash,
      incrementalDocumentDigest: sha256Node(JSON.stringify(cycle.incrementalDocument)),
      coldDocumentDigest: sha256Node(JSON.stringify(cycle.coldDocument)),
      expectation: cycle.expectation,
      runInvalidProbe: cycle.runInvalidProbe,
    })),
  }));
}

function preparedEditTypeCounts(model: PreparedModel): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cycle of model.cycles) {
    for (const type of cycle.expectation.editedFeatureTypes) counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

async function runBrowserModel(page: Page, model: PreparedModel, options: StressOptions): Promise<BrowserModelResult> {
  return page.evaluate(async (input) => {
    type AnyRecord = Record<string, any>;

    const fail: (message: string) => never = (message) => { throw new Error(`${input.model.id}: ${message}`); };
    const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
      if (!condition) fail(message);
    };
    const stableString = (value: unknown): string => JSON.stringify(value);
    const normalize = (value: any): any => {
      if (value == null || typeof value !== 'object') {
        // OCCT expands exact B-rep bounds by its 1e-7 modeling tolerance. A
        // serialize/restore path can spell that same zero-bound tolerance one
        // ULP differently, so canonicalize only this sub-micron zero noise.
        // Mesh coordinates, topology signatures, volumes, areas, and every
        // other finite response number remain bit-for-bit evidence.
        if (typeof value === 'number' && Math.abs(value) <= 1e-6) return 0;
        return typeof value === 'number' && Object.is(value, -0) ? 0 : value;
      }
      if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>).map(normalize);
      if (Array.isArray(value)) return value.map(normalize);
      const output: AnyRecord = {};
      for (const key of Object.keys(value).sort()) {
        if (value[key] !== undefined) output[key] = normalize(value[key]);
      }
      return output;
    };
    const firstDifference = (left: any, right: any, path = '$'): string | null => {
      if (Object.is(left, right)) return null;
      if (typeof left !== typeof right || left == null || right == null) {
        return `${path}: ${stableString(left)} !== ${stableString(right)}`;
      }
      if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) return `${path}: array kind differs`;
        if (left.length !== right.length) return `${path}.length: ${left.length} !== ${right.length}`;
        for (let index = 0; index < left.length; index += 1) {
          const difference = firstDifference(left[index], right[index], `${path}[${index}]`);
          if (difference) return difference;
        }
        return null;
      }
      if (typeof left === 'object') {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        if (stableString(leftKeys) !== stableString(rightKeys)) {
          return `${path} keys: ${stableString(leftKeys)} !== ${stableString(rightKeys)}`;
        }
        for (const key of leftKeys) {
          const difference = firstDifference(left[key], right[key], `${path}.${key}`);
          if (difference) return difference;
        }
        return null;
      }
      if (typeof left === 'string' && typeof right === 'string' && (left.length > 240 || right.length > 240)) {
        let offset = 0;
        while (offset < left.length && offset < right.length && left[offset] === right[offset]) offset += 1;
        const start = Math.max(0, offset - 40);
        return `${path}: long strings differ at ${offset} (length ${left.length} !== ${right.length}); `
          + `${stableString(left.slice(start, offset + 80))} !== ${stableString(right.slice(start, offset + 80))}`;
      }
      return `${path}: ${stableString(left)} !== ${stableString(right)}`;
    };
    const sha256 = async (source: string): Promise<string> => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
    };
    const normalizeMesh = (mesh: AnyRecord | null): any => {
      if (!mesh) return null;
      const topologyFaces = Array.isArray(mesh.topologyFaces) ? mesh.topologyFaces : [];
      const faceOrdinalById = new Map<string, number>();
      const normalizedFaces = topologyFaces.map((face: AnyRecord, index: number) => {
        faceOrdinalById.set(String(face.faceId), index);
        const { faceId: _faceId, ...semanticFace } = face;
        return normalize(semanticFace);
      });
      const faceOrdinal = (faceId: unknown): number | null => faceOrdinalById.get(String(faceId)) ?? null;
      const normalizedGroups = (mesh.faceGroups || []).map((group: AnyRecord) => ({
        start: group.start,
        count: group.count,
        faceOrdinal: faceOrdinal(group.faceId),
      }));
      const normalizedPlanarFaces = (mesh.planarFaces || []).map((face: AnyRecord) => {
        const { faceId, ...semanticFace } = face;
        return normalize({ ...semanticFace, faceOrdinal: faceOrdinal(faceId) });
      });
      const {
        topologyFaces: _topologyFaces,
        faceGroups: _faceGroups,
        planarFaces: _planarFaces,
        ...meshRest
      } = mesh;
      return normalize({
        ...meshRest,
        faceGroups: normalizedGroups,
        planarFaces: normalizedPlanarFaces,
        topologyFaces: normalizedFaces,
      });
    };
    const exactEvidence = (response: AnyRecord): any => normalize({
      kind: response.kind,
      errors: response.errors || [],
      warnings: response.warnings || [],
      bodies: [...(response.bodies || [])]
        .sort((left: AnyRecord, right: AnyRecord) => String(left.bodyId).localeCompare(String(right.bodyId)))
        .map((body: AnyRecord) => {
          const { mesh, ...bodyRest } = body;
          const geometryEvidence = structuredClone(bodyRest);
          for (const key of ['threadEvidence', 'kernelRobustnessEvidence']) {
            if (!Array.isArray(geometryEvidence[key])) continue;
            geometryEvidence[key] = geometryEvidence[key].map((entry: AnyRecord) => {
              const { documentHash: _documentHash, ...independent } = entry;
              return independent;
            });
          }
          return { ...normalize(geometryEvidence), mesh: normalizeMesh(mesh) };
        }),
    });
    const namedInventory = (response: AnyRecord): Map<string, string> => {
      const inventory = new Map<string, string>();
      const recordName = (
        bodyId: string,
        topologyKind: 'face' | 'edge' | 'vertex',
        name: string,
        geometryClass: string,
        exactEvidence: unknown,
      ): void => {
        const key = `${bodyId}/${topologyKind}/${name}`;
        assert(!inventory.has(key), `persistent topology name is ambiguous: ${key}`);
        inventory.set(key, stableString(normalize({
          identity: {
            bodyId,
            topologyKind,
            // Face names encode producer feature, operation role, and source
            // entity. Derived edge and vertex names encode the canonical named
            // incidence graph. Imported names are registry-backed opaque
            // lineage. Geometry family is deliberately not identity: an exact
            // parametric edit may specialize a B-spline into a plane or line.
            constructionLineage: name,
          },
          geometryClass,
          exactEvidence,
        })));
      };
      for (const body of response.bodies || []) {
        const bodyId = String(body.bodyId || '');
        const faces = body.mesh?.topologyFaces || [];
        const edges = body.mesh?.edges || [];
        const vertices = body.mesh?.topologyVertices || [];
        for (const face of faces) {
          assert(typeof face.name === 'string' && face.name.length > 0, `${bodyId}: exact face is unnamed`);
          recordName(bodyId, 'face', face.name, String(face.geomType || 'OTHER'), {
            sig: face.sig,
            geomType: face.geomType,
          });
        }
        for (const edge of edges) {
          assert(typeof edge.name === 'string' && edge.name.length > 0, `${bodyId}: exact edge is unnamed`);
          recordName(bodyId, 'edge', edge.name, String(edge.sig?.curveType || 'OTHER'), {
            sig: edge.sig,
            points: edge.points,
          });
        }
        for (const vertex of vertices) {
          assert(typeof vertex.name === 'string' && vertex.name.length > 0, `${bodyId}: exact vertex is unnamed`);
          recordName(bodyId, 'vertex', vertex.name, 'POINT', { sig: vertex.sig });
        }
      }
      return inventory;
    };
    const compareInventory = (left: Map<string, string>, right: Map<string, string>, label: string): void => {
      const leftKeys = [...left.keys()].sort();
      const rightKeys = [...right.keys()].sort();
      assert(stableString(leftKeys) === stableString(rightKeys), `${label}: named topology disappeared or appeared: ${stableString(leftKeys)} !== ${stableString(rightKeys)}`);
      for (const key of leftKeys) {
        assert(left.get(key) === right.get(key), `${label}: persistent name retargeted: ${key}`);
      }
    };
    const inventorySource = (inventory: Map<string, string>): string => stableString(
      [...inventory.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );
    const identityInventorySource = (inventory: Map<string, string>): string => stableString(
      [...inventory.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, source]) => [key, JSON.parse(source).identity]),
    );
    const compareHistoricalInventory = (
      previous: Map<string, string>,
      current: Map<string, string>,
      expectation: MutationExpectation,
      label: string,
    ): void => {
      const previousKeys = [...previous.keys()].sort();
      const currentKeys = [...current.keys()].sort();
      const previousKeySet = new Set(previousKeys);
      const currentKeySet = new Set(currentKeys);
      const topologyChangeBodies = new Set(expectation.topologyChangeBodyIds);
      for (const key of new Set([...previousKeys, ...currentKeys])) {
        if (previousKeySet.has(key) === currentKeySet.has(key)) continue;
        const bodyId = key.split('/')[0]!;
        assert(
          topologyChangeBodies.has(bodyId),
          `${label}: persistent topology mapping key changed outside an explicitly topology-changing body: ${key}`,
        );
      }
      const unchangedBodies = new Set(expectation.unchangedBodyIds);
      const changedBodies = new Set(expectation.changedBodyIds);
      for (const key of previousKeys.filter((entry) => currentKeySet.has(entry))) {
        const beforeSource = previous.get(key);
        const afterSource = current.get(key);
        assert(typeof beforeSource === 'string' && typeof afterSource === 'string', `${label}: topology evidence is missing for ${key}`);
        const before = JSON.parse(beforeSource);
        const after = JSON.parse(afterSource);
        assert(before.identity?.bodyId === after.identity?.bodyId, `${label}: persistent name moved between bodies: ${key}`);
        assert(
          unchangedBodies.has(before.identity?.bodyId) || changedBodies.has(before.identity?.bodyId),
          `${label}: body ${before.identity?.bodyId} is absent from the mutation expectation`,
        );
        assert(
          stableString(before.identity) === stableString(after.identity),
          `${label}: persistent construction lineage changed: ${key}`,
        );
        if (unchangedBodies.has(before.identity.bodyId)) {
          assert(
            beforeSource === afterSource,
            `${label}: persistent name silently retargeted on unchanged body ${before.identity.bodyId}: ${key}`,
          );
        }
      }
    };
    const assertHistoryOracleContract = (): void => {
      const key = 'body-oracle/face/Ffeature-oracle:sweep:side:sketch-oracle/entity-oracle';
      const evidence = (geometryClass: string, constructionLineage = 'Ffeature-oracle:sweep:side:sketch-oracle/entity-oracle') => stableString({
        exactEvidence: { geometryClass },
        geometryClass,
        identity: { bodyId: 'body-oracle', constructionLineage, topologyKind: 'face' },
      });
      const expectation: MutationExpectation = {
        routeId: 'topology-oracle',
        editedFeatureTypes: ['sweep'],
        evaluatedFeatureIds: [],
        reusedFeatureIds: [],
        changedBodyIds: ['body-oracle'],
        unchangedBodyIds: [],
        topologyChangeBodyIds: [],
      };
      compareHistoricalInventory(
        new Map([[key, evidence('BSPLINE_SURFACE')]]),
        new Map([[key, evidence('PLANE')]]),
        expectation,
        'topology-oracle/analytic-specialization',
      );
      let rejectedRetarget = false;
      try {
        compareHistoricalInventory(
          new Map([[key, evidence('PLANE')]]),
          new Map([[key, evidence('PLANE', 'Fother-feature:cap:start')]]),
          expectation,
          'topology-oracle/retarget',
        );
      } catch {
        rejectedRetarget = true;
      }
      assert(rejectedRetarget, 'topology identity oracle accepted a construction-lineage swap');
    };
    assertHistoryOracleContract();
    const assertValid = (response: AnyRecord, label: string): void => {
      assert(response.kind === 'rebuild-result', `${label}: exact worker did not return rebuild-result`);
      assert(Array.isArray(response.errors) && response.errors.length === 0, `${label}: kernel errors: ${stableString(response.errors)}`);
      assert(Array.isArray(response.warnings) && response.warnings.length === 0, `${label}: kernel warnings: ${stableString(response.warnings)}`);
      assert(
        Array.isArray(response.bodies) && response.bodies.length === input.model.allBodyIds.length,
        `${label}: expected exactly ${input.model.allBodyIds.length} bodies`,
      );
      const bodyIds = response.bodies.map((body: AnyRecord) => String(body.bodyId)).sort();
      const expectedBodyIds = [...input.model.allBodyIds].sort();
      assert(stableString(bodyIds) === stableString(expectedBodyIds), `${label}: body set differs: ${stableString(bodyIds)}`);
      for (const body of response.bodies) {
        assert(!body.error, `${label}/${body.bodyId}: ${body.error?.message || 'body error'}`);
        assert(body.lastValid !== true, `${label}/${body.bodyId}: exact worker used last-valid geometry`);
        assert(
          typeof body.exactBrep === 'string' && body.exactBrep.length > 0,
          `${label}/${body.bodyId}: test-only serialized OCCT BREP evidence is missing`,
        );
        assert(body.geometry?.valid === true, `${label}/${body.bodyId}: exact geometry is invalid`);
        assert(body.geometry?.brepValid === true, `${label}/${body.bodyId}: B-rep analyzer rejected the shape`);
        assert(body.geometry?.solidCount === 1, `${label}/${body.bodyId}: expected exactly one solid`);
        assert(typeof body.geometry?.volume === 'number' && body.geometry.volume > 1e-8, `${label}/${body.bodyId}: volume is not positive`);
        assert(body.mesh?.vertices?.length > 0, `${label}/${body.bodyId}: mesh vertices are missing`);
        assert(body.mesh?.triangles?.length > 0, `${label}/${body.bodyId}: mesh triangles are missing`);
        assert(body.mesh?.topologyFaces?.length > 0, `${label}/${body.bodyId}: topology faces are missing`);
        assert(body.mesh?.edges?.length > 0, `${label}/${body.bodyId}: topology edges are missing`);
        assert(body.mesh?.topologyVertices?.length > 0, `${label}/${body.bodyId}: topology vertices are missing`);
        for (const key of ['threadEvidence', 'kernelRobustnessEvidence']) {
          for (const evidence of body[key] || []) {
            assert(
              evidence.documentHash === response.effectiveDocumentHash,
              `${label}/${body.bodyId}: ${key} is not bound to the effective document hash`,
            );
          }
        }
        const topologyErrors = (body.mesh?.topologyDiagnostics || [])
          .filter((diagnostic: AnyRecord) => diagnostic.severity === 'error');
        assert(
          topologyErrors.length === 0,
          `${label}/${body.bodyId}: explicit topology diagnostics: ${stableString(topologyErrors)}`,
        );
      }
    };
    const assertTrace = (response: AnyRecord, expectation: MutationExpectation, label: string): void => {
      const evaluated = new Set<string>(response.evaluation?.evaluatedFeatureIds || []);
      const reused = new Set<string>(response.evaluation?.reusedFeatureIds || []);
      for (const featureId of expectation.evaluatedFeatureIds) {
        assert(evaluated.has(featureId), `${label}: dirty feature ${featureId} was not evaluated`);
        assert(!reused.has(featureId), `${label}: feature ${featureId} was both evaluated and reused`);
      }
      for (const featureId of expectation.reusedFeatureIds) {
        assert(reused.has(featureId), `${label}: unchanged feature ${featureId} was not reused`);
        assert(!evaluated.has(featureId), `${label}: reused feature ${featureId} was replayed`);
      }
      assert(
        stableString([...evaluated].sort()) === stableString([...expectation.evaluatedFeatureIds].sort()),
        `${label}: unexpected evaluated feature trace ${stableString([...evaluated].sort())}`,
      );
      assert(
        stableString([...reused].sort()) === stableString([...expectation.reusedFeatureIds].sort()),
        `${label}: unexpected reused feature trace ${stableString([...reused].sort())}`,
      );
    };
    const assertColdTrace = (response: AnyRecord, label: string): void => {
      const allFeatureIds = input.model.allFeatureIds;
      const evaluated = new Set<string>(response.evaluation?.evaluatedFeatureIds || []);
      const reused = new Set<string>(response.evaluation?.reusedFeatureIds || []);
      for (const featureId of allFeatureIds) {
        assert(evaluated.has(featureId), `${label}: cold rebuild did not evaluate ${featureId}`);
        assert(!reused.has(featureId), `${label}: cold rebuild unexpectedly reused ${featureId}`);
      }
      assert(stableString([...evaluated].sort()) === stableString([...allFeatureIds].sort()), `${label}: cold trace has unexpected features`);
      assert(reused.size === 0, `${label}: cold trace reused ${stableString([...reused].sort())}`);
    };
    const exactBrepFor = (response: AnyRecord, bodyId: string, label: string): string => {
      const body = (response.bodies || []).find((entry: AnyRecord) => entry.bodyId === bodyId);
      assert(body, `${label}: body ${bodyId} is missing`);
      assert(
        typeof body.exactBrep === 'string' && body.exactBrep.length > 0,
        `${label}: body ${bodyId} has no exact BREP evidence`,
      );
      return body.exactBrep;
    };
    const exactBreps = (response: AnyRecord, label: string): Map<string, string> => new Map(
      input.model.allBodyIds.map((bodyId: string) => [bodyId, exactBrepFor(response, bodyId, label)]),
    );
    const assertIntendedBodyMutation = (
      previous: Map<string, string>,
      current: AnyRecord,
      expectation: MutationExpectation,
      label: string,
    ): Map<string, string> => {
      const currentBreps = exactBreps(current, label);
      for (const bodyId of expectation.changedBodyIds) {
        assert(previous.has(bodyId), `${label}: changed-body oracle has no prior BREP for ${bodyId}`);
        assert(
          currentBreps.get(bodyId) !== previous.get(bodyId),
          `${label}: intended body ${bodyId} did not change exact BREP`,
        );
      }
      for (const bodyId of expectation.unchangedBodyIds) {
        assert(previous.has(bodyId), `${label}: unchanged-body oracle has no prior BREP for ${bodyId}`);
        assert(
          currentBreps.get(bodyId) === previous.get(bodyId),
          `${label}: independent body ${bodyId} changed exact BREP`,
        );
      }
      return currentBreps;
    };
    const diagnostics = (response: AnyRecord): any[] => normalize([
      ...(response.errors || []).map((entry: AnyRecord) => ({ source: 'project', ...entry })),
      ...(response.bodies || []).filter((body: AnyRecord) => body.error).map((body: AnyRecord) => ({
        source: `body:${body.bodyId}`,
        ...body.error,
      })),
    ]);
    const invalidDocument = (document: JsonDocument): JsonDocument => {
      const invalid = structuredClone(document);
      const part = invalid.partDefinitions.find((entry: AnyRecord) => entry.id === input.model.ids.partId);
      const fillet = part?.features.find((entry: AnyRecord) => entry.id === input.model.ids.filletFeatureId);
      assert(fillet, 'invalid topology probe could not find its fillet');
      fillet.edges = [{
        name: input.model.ids.invalidEdgeName,
        sig: { p: [0, 0, 0], l: 1, curveType: 'LINE' },
      }];
      return invalid;
    };
    const assertInvalid = (
      incremental: AnyRecord,
      cold: AnyRecord,
      precedingValid: AnyRecord,
      label: string,
    ): void => {
      assert(incremental.kind === 'rebuild-result' && cold.kind === 'rebuild-result', `${label}: invalid probe did not return rebuild results`);
      const incrementalDiagnostics = diagnostics(incremental);
      const coldDiagnostics = diagnostics(cold);
      const difference = firstDifference(incrementalDiagnostics, coldDiagnostics);
      assert(!difference, `${label}: incremental/cold diagnostics differ: ${difference}`);
      const codes = incrementalDiagnostics.map((entry) => entry.code).filter(Boolean);
      assert(codes.includes('TOPOLOGY_REFERENCE_MISSING'), `${label}: missing named topology did not produce TOPOLOGY_REFERENCE_MISSING: ${stableString(incrementalDiagnostics)}`);
      const incrementalStock = incremental.bodies.find((body: AnyRecord) => body.bodyId === input.model.ids.stockBodyId);
      const coldStock = cold.bodies.find((body: AnyRecord) => body.bodyId === input.model.ids.stockBodyId);
      for (const [workerKind, stock] of [['incremental', incrementalStock], ['cold', coldStock]] as const) {
        assert(stock, `${label}: ${workerKind} worker omitted the invalid stock body record`);
        assert(
          stock.lastValid !== true && !stock.mesh && !stock.exactBrep && !stock.geometry,
          `${label}: ${workerKind} worker published geometry for the invalid named reference`,
        );
        assert(stock.error, `${label}: ${workerKind} invalid stock body omitted its explicit error`);
      }
      for (const bodyId of input.model.allBodyIds.filter((candidate: string) => candidate !== input.model.ids.stockBodyId)) {
        const precedingBrep = exactBrepFor(precedingValid, bodyId, `${label}/preceding-valid`);
        const incrementalBody = incremental.bodies.find((body: AnyRecord) => body.bodyId === bodyId);
        const coldBody = cold.bodies.find((body: AnyRecord) => body.bodyId === bodyId);
        assert(incrementalBody?.exactBrep === precedingBrep, `${label}: incremental invalid probe changed independent body ${bodyId}`);
        assert(coldBody?.exactBrep === precedingBrep, `${label}: cold invalid probe changed independent body ${bodyId}`);
        assert(!incrementalBody?.error && !coldBody?.error, `${label}: invalid probe failed independent body ${bodyId}`);
        assert(incrementalBody?.lastValid !== true && coldBody?.lastValid !== true,
          `${label}: independent body ${bodyId} was incorrectly marked last-valid`);
      }
    };

    const studioScript = document.querySelector<HTMLScriptElement>('script[src*="/studio.js"]');
    assert(studioScript, 'versioned Studio entrypoint is missing');
    const workerUrl = `${new URL('.', studioScript.src).href}studio-kernel.worker.js`;
    let requestSerial = 0;
    const rebuild = async (worker: Worker, documentValue: JsonDocument, revision: number, purpose: string): Promise<AnyRecord> => {
      requestSerial += 1;
      const requestId = `cad-mutation-stress-${input.model.id}-${requestSerial}`;
      return new Promise<AnyRecord>((resolveResponse, rejectResponse) => {
        const timeout = setTimeout(() => {
          cleanup();
          rejectResponse(new Error(`${input.model.id}/${purpose} timed out after ${input.requestTimeoutMs} ms`));
        }, input.requestTimeoutMs);
        const onMessage = (event: MessageEvent<AnyRecord>): void => {
          const data = event.data;
          if (data?.kind === 'kernel-status' && data.status === 'failed') {
            cleanup();
            rejectResponse(new Error(data.message || 'CAD kernel initialization failed'));
            return;
          }
          if (data?.requestId !== requestId) return;
          cleanup();
          if (data.kind === 'kernel-error') rejectResponse(new Error(data.message || 'CAD kernel error'));
          else resolveResponse(data);
        };
        const onError = (event: ErrorEvent): void => {
          cleanup();
          rejectResponse(new Error(event.message || 'CAD worker failed'));
        };
        const cleanup = (): void => {
          clearTimeout(timeout);
          worker.removeEventListener('message', onMessage);
          worker.removeEventListener('error', onError);
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.postMessage({
          kind: 'rebuild',
          requestId,
          projectId: documentValue.projectId,
          revision,
          includeExactBrep: true,
          document: documentValue,
        });
      });
    };
    const coldRebuild = async (documentValue: JsonDocument, purpose: string): Promise<AnyRecord> => {
      const worker = new Worker(workerUrl, { type: 'module' });
      try {
        return await rebuild(worker, documentValue, 1, purpose);
      } finally {
        worker.terminate();
      }
    };
    const compareExact = async (incremental: AnyRecord, cold: AnyRecord, label: string): Promise<string> => {
      const incrementalEvidence = exactEvidence(incremental);
      const coldEvidence = exactEvidence(cold);
      const difference = firstDifference(incrementalEvidence, coldEvidence);
      assert(!difference, `${label}: incremental output differs from cold full rebuild: ${difference}`);
      const incrementalNames = namedInventory(incremental);
      const coldNames = namedInventory(cold);
      compareInventory(incrementalNames, coldNames, `${label}/incremental-vs-cold`);
      return sha256(stableString(incrementalEvidence));
    };

    const incrementalWorker = new Worker(workerUrl, { type: 'module' });
    let incrementalRevision = 0;
    let invalidProbes = 0;
    let finalDigest = '';
    try {
      incrementalRevision += 1;
      const baselineIncremental = await rebuild(
        incrementalWorker,
        input.model.baseline.incrementalDocument,
        incrementalRevision,
        'baseline/incremental',
      );
      const baselineCold = await coldRebuild(input.model.baseline.coldDocument, 'baseline/cold');
      assertValid(baselineIncremental, 'baseline/incremental');
      assertValid(baselineCold, 'baseline/cold');
      assertColdTrace(baselineIncremental, 'baseline/incremental');
      assertColdTrace(baselineCold, 'baseline/cold');
      const baselineDigest = await compareExact(baselineIncremental, baselineCold, 'baseline');
      const expectedNamedInventory = namedInventory(baselineCold);
      const expectedNameKeys = [...expectedNamedInventory.keys()].sort();
      const topologyIdentityDigests = [await sha256(identityInventorySource(expectedNamedInventory))];
      const topologyEvidenceDigests = [await sha256(inventorySource(expectedNamedInventory))];
      assert(expectedNameKeys.length > 0, 'baseline has no persistent topology names');
      for (const requiredNameKey of input.model.requiredNameKeys) {
        assert(expectedNamedInventory.has(requiredNameKey), `required persistent topology is missing at baseline: ${requiredNameKey}`);
      }
      let previousValidBreps = exactBreps(baselineCold, 'baseline/cold');
      let previousNamedInventory = expectedNamedInventory;

      for (const cycle of input.model.cycles) {
        incrementalRevision += 1;
        const incremental = await rebuild(
          incrementalWorker,
          cycle.incrementalDocument,
          incrementalRevision,
          `cycle-${cycle.cycle}/incremental`,
        );
        const cold = await coldRebuild(cycle.coldDocument, `cycle-${cycle.cycle}/cold`);
        assertValid(incremental, `cycle-${cycle.cycle}/incremental`);
        assertValid(cold, `cycle-${cycle.cycle}/cold`);
        assertTrace(incremental, cycle.expectation, `cycle-${cycle.cycle}/incremental`);
        assertColdTrace(cold, `cycle-${cycle.cycle}/cold`);
        finalDigest = await compareExact(incremental, cold, `cycle-${cycle.cycle}`);
        previousValidBreps = assertIntendedBodyMutation(
          previousValidBreps,
          cold,
          cycle.expectation,
          `cycle-${cycle.cycle}/cold`,
        );
        const currentNames = namedInventory(cold);
        compareHistoricalInventory(
          previousNamedInventory,
          currentNames,
          cycle.expectation,
          `cycle-${cycle.cycle}/topology-history`,
        );
        topologyIdentityDigests.push(await sha256(identityInventorySource(currentNames)));
        topologyEvidenceDigests.push(await sha256(inventorySource(currentNames)));
        previousNamedInventory = currentNames;
        // Probe failure recovery only after proving the valid edit's dirty
        // subgraph. Running the invalid variant first would legitimately
        // evaluate that edit and make the immediately following valid rebuild
        // appear reused, weakening the trace oracle.
        if (cycle.runInvalidProbe) {
          invalidProbes += 1;
          incrementalRevision += 1;
          const invalidIncremental = await rebuild(
            incrementalWorker,
            invalidDocument(cycle.incrementalDocument),
            incrementalRevision,
            `cycle-${cycle.cycle}/invalid-incremental`,
          );
          const invalidCold = await coldRebuild(
            invalidDocument(cycle.coldDocument),
            `cycle-${cycle.cycle}/invalid-cold`,
          );
          assertInvalid(invalidIncremental, invalidCold, cold, `cycle-${cycle.cycle}/invalid`);
        }
        if (cycle.cycle % input.progressEvery === 0 || cycle.cycle === input.model.cycles.length) {
          console.log(`[mutation-stress] ${input.model.id} ${cycle.cycle}/${input.model.cycles.length} exact edits OK`);
        }
      }

      return {
        modelId: input.model.id,
        scenarioId: input.model.scenarioId,
        meaningfulFeatureTypes: input.model.meaningfulFeatureTypes,
        editTypeCounts: input.model.cycles.reduce((counts: Record<string, number>, entry: PreparedCycle) => {
          for (const type of entry.expectation.editedFeatureTypes) counts[type] = (counts[type] || 0) + 1;
          return counts;
        }, {}),
        cycles: input.model.cycles.length,
        invalidProbes,
        namedTopologyCount: expectedNameKeys.length,
        baselineDigest,
        finalDigest: finalDigest || baselineDigest,
        topologyIdentityDigest: await sha256(stableString(topologyIdentityDigests)),
        topologyHistoryDigest: await sha256(stableString(topologyEvidenceDigests)),
      };
    } finally {
      incrementalWorker.terminate();
    }
  }, {
    model,
    requestTimeoutMs: options.requestTimeoutMs,
    progressEvery: options.progressEvery,
  }) as Promise<BrowserModelResult>;
}

const options = parseOptions(process.argv.slice(2));
const distDirectory = resolve(repositoryRoot, 'dist');
invariant(existsSync(resolve(distDirectory, 'index.html')), 'dist is missing; run npm run build before the mutation harness');
const api = await schemaApi();
const scenarios = await scenarioDefinitions();
invariant(scenarios.length === 8, `expected 8 structural scenarios, received ${scenarios.length}`);
invariant(new Set(scenarios.map((scenario) => scenario.id)).size === scenarios.length, 'scenario IDs are not unique');
const declaredFeatureTypes = [...new Set(scenarios.flatMap((scenario) => scenario.meaningfulFeatureTypes))].sort();
invariant(
  JSON.stringify(declaredFeatureTypes) === JSON.stringify([...api.featureTypes].sort()),
  `scenario coverage does not exhaust the feature registry: ${JSON.stringify(declaredFeatureTypes)}`,
);
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-cad-mutation-stress-'));
let local: RunningPartModeServer | undefined;
let browser: Browser | undefined;
const results: Array<BrowserModelResult | undefined> = Array.from({ length: options.models });
const startedAt = Date.now();
const suiteFingerprintPaths = Object.freeze([
  fileURLToPath(import.meta.url),
  resolve(scriptDirectory, '..', 'src', 'server.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-project-v5.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-v5-runtime-document.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-v5-feature-types.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-agent-service.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-direct-edit.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-imported-topology-registry.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-sheet-metal.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-structural-members.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-structural-treatments.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-thread.js'),
  resolve(repositoryRoot, 'src', 'static', 'studio-weld-beads.js'),
  resolve(repositoryRoot, 'src', 'static', 'vendor', 'replicad.module.js'),
  resolve(repositoryRoot, 'src', 'static', 'vendor', 'replicad-oc.module.js'),
  resolve(repositoryRoot, 'src', 'static', 'vendor', 'replicad_single.wasm'),
  resolve(repositoryRoot, 'tests', 'cad-corpus', 'boolean-cut.partmode.json'),
  resolve(repositoryRoot, 'tests', 'cad-corpus', 'fillet-shell.partmode.json'),
  resolve(repositoryRoot, 'tests', 'cad-corpus', 'loft-sections.partmode.json'),
  resolve(repositoryRoot, 'tests', 'cad-corpus', 'profile-pattern.partmode.json'),
  resolve(repositoryRoot, 'tests', 'cad-corpus', 'sweep-path.partmode.json'),
  resolve(repositoryRoot, 'tests', 'feature-registry-runtime', 'registered-features.partmode.json'),
]);
const suiteFingerprint = fingerprintFiles([...suiteFingerprintPaths]);
const distFingerprint = directoryFingerprint(distDirectory);
const checkpointConfiguration: StressCheckpoint['configuration'] = {
  professionalCoreAcceptance: options.professionalCoreAcceptance,
  models: options.models,
  cycles: options.cycles,
  invalidEvery: options.invalidEvery,
  seed: options.seed,
  scenarioOffset: options.scenarioOffset,
  scenarioIds: scenarios.map((scenario) => scenario.id),
  registeredFeatureTypes: [...api.featureTypes],
};
const expectedInvalidProbesPerModel = options.invalidEvery > 0
  ? Math.floor(options.cycles / options.invalidEvery)
  : 0;
let checkpoint: StressCheckpoint | undefined;
const checkpointByModel = new Map<number, CheckpointModelResult>();
let resumedModels = 0;
let executedModels = 0;

if (options.checkpointPath) {
  if (options.resume) {
    invariant(existsSync(options.checkpointPath), `resume checkpoint does not exist: ${options.checkpointPath}`);
    checkpoint = readCheckpoint(options.checkpointPath);
    invariant(checkpoint.suiteFingerprint === suiteFingerprint, 'checkpoint was produced by a different mutation harness');
    invariant(checkpoint.distFingerprint === distFingerprint, 'checkpoint was produced from a different dist build');
    invariant(
      JSON.stringify(checkpoint.configuration) === JSON.stringify(checkpointConfiguration),
      'checkpoint configuration does not match the acceptance profile/models/cycles/invalidEvery/seed/scenario registry',
    );
    for (const entry of checkpoint.results) {
      invariant(Number.isInteger(entry.modelIndex) && entry.modelIndex >= 0 && entry.modelIndex < options.models, 'checkpoint model index is outside this run');
      invariant(/^[0-9a-f]{64}$/.test(entry.inputDigest), `checkpoint model ${entry.modelIndex} input digest is invalid`);
      invariant(/^[0-9a-f]{64}$/.test(entry.result?.baselineDigest), `checkpoint model ${entry.modelIndex} baseline evidence is invalid`);
      invariant(/^[0-9a-f]{64}$/.test(entry.result?.finalDigest), `checkpoint model ${entry.modelIndex} final evidence is invalid`);
      invariant(/^[0-9a-f]{64}$/.test(entry.result?.topologyIdentityDigest), `checkpoint model ${entry.modelIndex} topology-identity evidence is invalid`);
      invariant(/^[0-9a-f]{64}$/.test(entry.result?.topologyHistoryDigest), `checkpoint model ${entry.modelIndex} topology-history evidence is invalid`);
      invariant(entry.result.cycles === options.cycles, `checkpoint model ${entry.modelIndex} cycle count is invalid`);
      invariant(entry.result.invalidProbes === expectedInvalidProbesPerModel, `checkpoint model ${entry.modelIndex} invalid-probe count is invalid`);
      invariant(Number.isInteger(entry.result.namedTopologyCount) && entry.result.namedTopologyCount > 0, `checkpoint model ${entry.modelIndex} named-topology evidence is invalid`);
      const expectedScenario = scenarios[(entry.modelIndex + options.scenarioOffset) % scenarios.length];
      invariant(entry.result.scenarioId === expectedScenario?.id, `checkpoint model ${entry.modelIndex} scenario is invalid`);
      invariant(
        JSON.stringify(entry.result.meaningfulFeatureTypes) === JSON.stringify(expectedScenario?.meaningfulFeatureTypes.slice().sort()),
        `checkpoint model ${entry.modelIndex} feature coverage is invalid`,
      );
      invariant(entry.result.editTypeCounts && typeof entry.result.editTypeCounts === 'object', `checkpoint model ${entry.modelIndex} edit coverage is invalid`);
      checkpointByModel.set(entry.modelIndex, entry);
    }
    checkpoint.status = 'running';
    persistCheckpoint(options.checkpointPath, checkpoint);
  } else {
    invariant(!existsSync(options.checkpointPath), `checkpoint already exists; use --resume or choose a new path: ${options.checkpointPath}`);
    checkpoint = {
      format: 'partmode-cad-mutation-stress/v4',
      status: 'running',
      suiteFingerprint,
      distFingerprint,
      configuration: checkpointConfiguration,
      results: [],
      checkpointDigest: '',
    };
    persistCheckpoint(options.checkpointPath, checkpoint);
  }
}

console.log(
  `CAD mutation stress: mode=${options.mode} models=${options.models} cycles=${options.cycles} ` +
  `acceptance=${options.professionalCoreAcceptance ? 'professional-core' : 'diagnostic'} ` +
  `invalidEvery=${options.invalidEvery} jobs=${options.jobs} seed=${options.seed} scenarioOffset=${options.scenarioOffset}`,
);
console.log(`evidence fingerprints: suite=${suiteFingerprint.slice(0, 16)} dist=${distFingerprint.slice(0, 16)}`);
if (checkpoint) console.log(`checkpoint: ${options.checkpointPath} (${checkpoint.results.length} completed models available)`);

try {
  local = await startPartModeServer({
    distDir: distDirectory,
    host: '127.0.0.1',
    port: 0,
    stateDir: resolve(temporaryDirectory, 'state'),
  });
  const healthResponse = await fetch(new URL('/healthz', local.url));
  invariant(healthResponse.ok, `local PartMode health returned HTTP ${healthResponse.status}`);
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 86_400_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const activeBrowser = browser;
  let nextModelIndex = 0;
  const runLane = async (lane: number): Promise<void> => {
    let page: Page | undefined;
    const ensurePage = async (): Promise<Page> => {
      if (page) return page;
      page = await activeBrowser.newPage();
      page.on('console', (message) => {
        const text = message.text();
        if (text.startsWith('[mutation-stress]')) console.log(text);
      });
      const response = await page.goto(local!.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      invariant(response?.status() === 200, `lane ${lane}: local PartMode page returned HTTP ${response?.status() ?? 0}`);
      return page;
    };
    try {
      while (nextModelIndex < options.models) {
        const modelIndex = nextModelIndex;
        nextModelIndex += 1;
        const prepared = await prepareModel(modelIndex, options, api, scenarios);
        const inputDigest = preparedModelDigest(prepared);
        console.log(`schema ${prepared.id}/${prepared.scenarioId}: baseline + ${prepared.cycles.length} deterministic save/reopen edits OK`);
        const resumed = checkpointByModel.get(modelIndex);
        if (resumed) {
          invariant(resumed.inputDigest === inputDigest, `${prepared.id}: checkpoint input evidence does not match the generated model`);
          invariant(resumed.result.modelId === prepared.id, `${prepared.id}: checkpoint result belongs to another model`);
          invariant(resumed.result.scenarioId === prepared.scenarioId, `${prepared.id}: checkpoint scenario evidence is stale`);
          invariant(
            JSON.stringify(resumed.result.editTypeCounts) === JSON.stringify(preparedEditTypeCounts(prepared)),
            `${prepared.id}: checkpoint edit-type evidence is stale`,
          );
          results[modelIndex] = resumed.result;
          resumedModels += 1;
          console.log(`resume ${prepared.id}: exact kernel evidence accepted for identical suite, build, and input`);
          continue;
        }
        const modelPage = await ensurePage();
        const modelStartedAt = Date.now();
        const result = await runBrowserModel(modelPage, prepared, options);
        invariant(result.modelId === prepared.id, `${prepared.id}: browser returned evidence for another model`);
        invariant(result.cycles === options.cycles, `${prepared.id}: browser returned the wrong cycle count`);
        invariant(
          result.invalidProbes === expectedInvalidProbesPerModel,
          `${prepared.id}: browser returned the wrong invalid-probe count`,
        );
        invariant(/^[0-9a-f]{64}$/.test(result.baselineDigest), `${prepared.id}: browser baseline evidence is invalid`);
        invariant(/^[0-9a-f]{64}$/.test(result.finalDigest), `${prepared.id}: browser final evidence is invalid`);
        invariant(/^[0-9a-f]{64}$/.test(result.topologyIdentityDigest), `${prepared.id}: browser topology-identity evidence is invalid`);
        invariant(/^[0-9a-f]{64}$/.test(result.topologyHistoryDigest), `${prepared.id}: browser topology-history evidence is invalid`);
        invariant(
          Number.isInteger(result.namedTopologyCount) && result.namedTopologyCount > 0,
          `${prepared.id}: browser named-topology evidence is invalid`,
        );
        invariant(result.scenarioId === prepared.scenarioId, `${prepared.id}: browser returned the wrong scenario evidence`);
        invariant(
          JSON.stringify(result.meaningfulFeatureTypes) === JSON.stringify(prepared.meaningfulFeatureTypes),
          `${prepared.id}: browser returned the wrong feature-type coverage`,
        );
        invariant(
          JSON.stringify(result.editTypeCounts) === JSON.stringify(preparedEditTypeCounts(prepared)),
          `${prepared.id}: browser returned the wrong edit-type evidence`,
        );
        results[modelIndex] = result;
        executedModels += 1;
        const modelSeconds = Math.round((Date.now() - modelStartedAt) / 100) / 10;
        console.log(
          `kernel ${result.modelId}: ${result.cycles} incremental/cold exact comparisons, ` +
          `${result.invalidProbes} fail-closed probes, ${result.namedTopologyCount} persistent names OK (${modelSeconds}s)`,
        );
        if (checkpoint && options.checkpointPath) {
          const entry = { modelIndex, inputDigest, result };
          checkpoint.results.push(entry);
          checkpointByModel.set(modelIndex, entry);
          persistCheckpoint(options.checkpointPath, checkpoint);
        }
      }
    } finally {
      await page?.close();
    }
  };
  await Promise.all(Array.from({ length: options.jobs }, (_, lane) => runLane(lane + 1)));

  const completedResults = results.filter((result): result is BrowserModelResult => result !== undefined);
  const totalCycles = completedResults.reduce((total, result) => total + result.cycles, 0);
  const totalInvalidProbes = completedResults.reduce((total, result) => total + result.invalidProbes, 0);
  const topologyIdentityDigest = sha256Node(JSON.stringify(
    completedResults.map((result) => [result.modelId, result.topologyIdentityDigest]),
  ));
  const topologyHistoryDigest = sha256Node(JSON.stringify(
    completedResults.map((result) => [result.modelId, result.topologyHistoryDigest]),
  ));
  const executedExactComparisons = executedModels * options.cycles;
  const resumedExactComparisons = resumedModels * options.cycles;
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  invariant(completedResults.length === options.models, 'not every generated model reached the exact worker or matching checkpoint');
  invariant(totalCycles === options.models * options.cycles, 'not every deterministic edit was compared');
  invariant(
    totalInvalidProbes === options.models * expectedInvalidProbesPerModel,
    'not every configured invalid-reference probe was evidenced',
  );
  const scenarioCounts: Record<string, number> = {};
  const meaningfulTypeModelCounts: Record<string, number> = {};
  const editTypeCounts: Record<string, number> = {};
  for (const result of completedResults) {
    scenarioCounts[result.scenarioId] = (scenarioCounts[result.scenarioId] || 0) + 1;
    for (const type of result.meaningfulFeatureTypes) {
      meaningfulTypeModelCounts[type] = (meaningfulTypeModelCounts[type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(result.editTypeCounts)) {
      invariant(Number.isInteger(count) && count > 0, `${result.modelId}: invalid edit coverage for ${type}`);
      editTypeCounts[type] = (editTypeCounts[type] || 0) + count;
    }
  }
  for (const scenario of scenarios) invariant((scenarioCounts[scenario.id] || 0) > 0, `scenario ${scenario.id} was not executed`);
  const requiredModelsPerType = options.professionalCoreAcceptance ? 20 : 1;
  for (const type of api.featureTypes) {
    invariant(
      (meaningfulTypeModelCounts[type] || 0) >= requiredModelsPerType,
      `feature type ${type} has only ${meaningfulTypeModelCounts[type] || 0}/${requiredModelsPerType} meaningful models`,
    );
    if (type !== 'imported-step') {
      invariant((editTypeCounts[type] || 0) > 0, `feature type ${type} was present but never exercised by a geometry edit`);
    }
  }
  invariant(
    fingerprintFiles([...suiteFingerprintPaths]) === suiteFingerprint,
    'mutation harness, schema, fixtures, registry, or bundled OCCT inputs changed during the run',
  );
  invariant(
    directoryFingerprint(distDirectory) === distFingerprint,
    'dist build changed during the mutation run; mixed-build evidence was rejected',
  );
  if (checkpoint && options.checkpointPath) {
    invariant(checkpoint.results.length === options.models, 'checkpoint does not contain every model result');
    checkpoint.status = 'ok';
    persistCheckpoint(options.checkpointPath, checkpoint);
  }
  console.log(
    `CAD mutation stress OK: ${completedResults.length} valid schema-5 models, ${totalCycles} deterministic edits, ` +
    `${totalCycles} evidenced fresh-worker comparisons, ${totalInvalidProbes} explicit invalid-reference probes; ` +
    `${executedModels} models executed and ${resumedModels} resumed from build-bound evidence (${elapsedSeconds}s)`,
  );
  console.log(JSON.stringify({
    status: 'ok',
    mode: options.mode,
    professionalCoreAcceptance: options.professionalCoreAcceptance,
    models: completedResults.length,
    cyclesPerModel: options.cycles,
    exactComparisons: totalCycles,
    executedExactComparisons,
    resumedExactComparisons,
    invalidProbes: totalInvalidProbes,
    seed: options.seed,
    scenarioOffset: options.scenarioOffset,
    jobs: options.jobs,
    executedModels,
    resumedModels,
    scenarioCounts,
    meaningfulTypeModelCounts,
    editTypeCounts,
    topologyIdentityDigest,
    topologyHistoryDigest,
    suiteFingerprint,
    distFingerprint,
    ...(options.checkpointPath ? { checkpointPath: options.checkpointPath } : {}),
    elapsedSeconds,
  }));
} finally {
  await browser?.close();
  if (local) await new Promise<void>((resolveClose) => local?.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
