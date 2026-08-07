import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Dependency management smoke failed: ${name}`);
}

function edgeKeys(result: any): string[] {
  return result.items.map((edge: any) =>
    `${edge.from.kind}:${edge.from.id}>${edge.relation}>${edge.to.kind}:${edge.to.id}${edge.depth ? `@${edge.depth}` : ''}`);
}

function throws(name: string, fn: () => unknown, text: string): void {
  try {
    fn();
  } catch (error: any) {
    check(name, String(error?.message || error).includes(text));
    return;
  }
  throw new Error(`Dependency management smoke failed: ${name}`);
}

const root = process.cwd();
const moduleAt = async (path: string): Promise<any> => import(pathToFileURL(resolve(root, path)).href);
const agent = await moduleAt('src/static/studio-agent-service.js');
const runtime = await moduleAt('src/static/studio-v5-runtime-document.js');

const registered = JSON.parse(readFileSync(
  resolve(root, 'tests/feature-registry-runtime/registered-features.partmode.json'),
  'utf8',
)) as any;
const registeredService = new agent.CadCommandService({ project: registered });

const direct = registeredService.inspect({
  kind: 'entity.dependencies',
  entity: { kind: 'datum', id: 'datum-revolve-profile' },
});
check('default query remains a direct bidirectional incident-edge query',
  JSON.stringify(edgeKeys(direct)) === JSON.stringify([
    'datum:datum-revolve-profile>supports>sketch:sketch-revolve-profile',
  ]));

const downstream = registeredService.inspect({
  kind: 'entity.dependencies',
  entity: { kind: 'datum', id: 'datum-revolve-profile' },
  direction: 'downstream',
  transitive: true,
});
check('where-used follows the complete datum to sketch to feature to body chain',
  JSON.stringify(edgeKeys(downstream)) === JSON.stringify([
    'datum:datum-revolve-profile>supports>sketch:sketch-revolve-profile@1',
    'sketch:sketch-revolve-profile>input>feature:feature-revolve@2',
    'feature:feature-revolve>creates>body:body-revolve@3',
  ]));

const upstream = registeredService.inspect({
  kind: 'entity.dependencies',
  entity: { kind: 'body', id: 'body-revolve' },
  direction: 'upstream',
  transitive: true,
});
check('dependency lookup reverses the same complete chain',
  JSON.stringify(edgeKeys(upstream)) === JSON.stringify([
    'feature:feature-revolve>creates>body:body-revolve@1',
    'sketch:sketch-revolve-profile>input>feature:feature-revolve@2',
    'datum:datum-revolve-axis>input>feature:feature-revolve@2',
    'datum:datum-revolve-profile>supports>sketch:sketch-revolve-profile@3',
  ]));

const inputOnly = registeredService.inspect({
  kind: 'entity.dependencies',
  entity: { kind: 'sketch', id: 'sketch-revolve-profile' },
  direction: 'downstream',
  transitive: true,
  relation: 'input',
});
check('relation filters constrain traversal as well as output',
  JSON.stringify(edgeKeys(inputOnly)) === JSON.stringify([
    'sketch:sketch-revolve-profile>input>feature:feature-revolve@1',
  ]));

const pageOne = registeredService.inspect({ kind: 'entity.dependencies', pageSize: 5 });
const pageTwo = registeredService.inspect({ kind: 'entity.dependencies', pageSize: 5, cursor: pageOne.nextCursor });
check('complete graph pagination is deterministic and non-overlapping',
  pageOne.items.length === 5
  && pageTwo.items.length === 5
  && pageOne.nextCursor === '5'
  && !edgeKeys(pageOne).some((entry) => edgeKeys(pageTwo).includes(entry)));

throws('unknown dependency target fails closed', () => registeredService.inspect({
  kind: 'entity.dependencies',
  entity: { kind: 'body', id: 'body-does-not-exist' },
}), 'does not exist');
throws('invalid traversal direction fails closed', () => registeredService.inspect({
  kind: 'entity.dependencies',
  entity: { kind: 'body', id: 'body-revolve' },
  direction: 'sideways',
}), 'direction must be');
throws('datum delete reports its named dependent',
  () => runtime.deleteStudioV5Datum(registered, 'datum-revolve-profile'),
  'Revolve profile');
throws('sketch delete reports its named dependent',
  () => runtime.deleteStudioV5AdvancedSketch(registered, 'sketch-revolve-profile'),
  'Exact partial revolve');

const patterns = JSON.parse(readFileSync(
  resolve(root, 'tests/body-pattern-runtime/body-patterns.partmode.json'),
  'utf8',
)) as any;
const patternService = new agent.CadCommandService({ project: patterns });
const datumPatterns = patternService.inspect({
  kind: 'entity.dependencies',
  entity: { kind: 'datum', id: 'datum-pattern-direction' },
  direction: 'downstream',
});
check('pattern direction datum reports both where-used records',
  JSON.stringify(edgeKeys(datumPatterns)) === JSON.stringify([
    'datum:datum-pattern-direction>input>body-pattern:pattern-linked',
    'datum:datum-pattern-direction>input>body-pattern:pattern-union',
  ]));

const assemblyFixture = JSON.parse(readFileSync(
  resolve(root, 'tests/assembly-runtime/two-part-constrained.partmode.json'),
  'utf8',
)) as any;
const patternedAssembly = runtime.createStudioV5OccurrencePattern(assemblyFixture, {
  id: 'occurrence-pattern-moving',
  name: 'Moving component pattern',
  kind: 'linear',
  sourceOccurrenceIds: ['occurrence-moving'],
  generatedCount: 2,
  definition: { direction: [0, 1, 0], spacing: 30 },
});
const assemblyService = new agent.CadCommandService({ project: patternedAssembly });
const partWhereUsed = assemblyService.inspect({
  kind: 'entity.dependencies',
  entity: { kind: 'part', id: 'part-moving-block' },
  direction: 'downstream',
  transitive: true,
});
check('part where-used reaches its occurrence, mates, and occurrence pattern',
  JSON.stringify(edgeKeys(partWhereUsed)) === JSON.stringify([
    'part:part-moving-block>instantiates>occurrence:occurrence-moving@1',
    'occurrence:occurrence-moving>constrains>mate:mate-corner-x@2',
    'occurrence:occurrence-moving>constrains>mate:mate-corner-y@2',
    'occurrence:occurrence-moving>constrains>mate:mate-corner-z@2',
    'occurrence:occurrence-moving>patterns>occurrence-pattern:occurrence-pattern-moving@2',
  ]));

const deletedOccurrence = runtime.deleteStudioV5ComponentOccurrence(patternedAssembly, 'occurrence-moving');
const remainingAssembly = runtime.studioV5RootAssembly(deletedOccurrence);
check('occurrence deletion cascades through dependent mates and patterns',
  remainingAssembly.occurrences.every((entry: any) => entry.id !== 'occurrence-moving')
  && remainingAssembly.mates.length === 0
  && remainingAssembly.occurrencePatterns.length === 0);

console.log(JSON.stringify({
  whereUsed: {
    datumToBodyDepth: 3,
    partDependents: partWhereUsed.total,
    patternDatumUsers: datumPatterns.total,
  },
  management: {
    guardedDeletes: ['datum', 'sketch'],
    cascadedDeletes: ['body', 'occurrence'],
    pagination: true,
    failClosedQueries: true,
  },
}, null, 2));
