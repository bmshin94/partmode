import { canonicalStudioV5Project, studioV5CanonicalHash } from './studio-v5-runtime-document.js';

export const STUDIO_PDM_SCHEMA = 'partmode.pdm/v1';
export const STUDIO_PDM_STATES = Object.freeze(['work-in-progress', 'in-review', 'released', 'obsolete']);

const clone = (value) => structuredClone(value);
const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,199}$/u;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u;

export class StudioPdmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioPdmError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new StudioPdmError(code, message, details);
}

function requiredText(value, label, maximum = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail('PDM_INPUT_INVALID', `${label} must be non-empty text no longer than ${maximum} characters.`);
  return value.trim();
}

function actor(value, label = 'Actor') {
  const result = requiredText(value, label, 200);
  if (!ID.test(result)) fail('PDM_INPUT_INVALID', `${label} must be a stable identifier.`);
  return result;
}

function instant(value, label = 'Timestamp') {
  const result = requiredText(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(result) || Number.isNaN(Date.parse(result))) {
    fail('PDM_INPUT_INVALID', `${label} must be an ISO-8601 UTC timestamp.`);
  }
  return result;
}

function contentSnapshot(project) {
  const snapshot = canonicalStudioV5Project(project);
  if (snapshot.extensions?.pdm) {
    delete snapshot.extensions.pdm;
    if (!Object.keys(snapshot.extensions).length) delete snapshot.extensions;
  }
  return canonicalStudioV5Project(snapshot);
}

function attach(project, graph) {
  const candidate = canonicalStudioV5Project(project);
  candidate.extensions = { ...(candidate.extensions || {}), pdm: clone(graph) };
  return canonicalStudioV5Project(candidate);
}

function verifySnapshot(version) {
  const snapshot = contentSnapshot(version.snapshot);
  const actual = studioV5CanonicalHash(snapshot);
  if (actual !== version.documentHash) {
    fail('PDM_VERSION_TAMPERED', `Version "${version.id}" content does not match its immutable hash.`, { versionId: version.id, expected: version.documentHash, actual });
  }
  return snapshot;
}

function validateGraph(value) {
  if (!value || typeof value !== 'object' || value.schema !== STUDIO_PDM_SCHEMA) fail('PDM_NOT_INITIALIZED', 'Project does not contain a supported PDM record.');
  if (!Number.isInteger(value.sequence) || value.sequence < 1) fail('PDM_GRAPH_INVALID', 'PDM sequence is invalid.');
  if (!Array.isArray(value.branches) || !value.branches.length || !Array.isArray(value.versions) || !value.versions.length) fail('PDM_GRAPH_INVALID', 'PDM graph requires branches and versions.');
  const graph = clone(value);
  const versions = new Map();
  for (const version of graph.versions) {
    if (!version?.id || versions.has(version.id)) fail('PDM_GRAPH_INVALID', 'PDM version ids are missing or duplicated.');
    if (!STUDIO_PDM_STATES.includes(version.state)) fail('PDM_GRAPH_INVALID', `Version "${version.id}" has an invalid release state.`);
    if (!Array.isArray(version.parentVersionIds) || !Array.isArray(version.approvals) || !Array.isArray(version.transitions)) fail('PDM_GRAPH_INVALID', `Version "${version.id}" history is incomplete.`);
    versions.set(version.id, version);
  }
  for (const version of versions.values()) {
    for (const parentId of version.parentVersionIds) if (!versions.has(parentId)) fail('PDM_GRAPH_INVALID', `Version "${version.id}" has a missing parent.`);
    verifySnapshot(version);
  }
  const branches = new Map();
  const names = new Set();
  for (const branch of graph.branches) {
    if (!branch?.id || branches.has(branch.id) || !BRANCH_NAME.test(branch.name || '')) fail('PDM_GRAPH_INVALID', 'PDM branch identity is invalid.');
    const folded = branch.name.toLowerCase();
    if (names.has(folded)) fail('PDM_GRAPH_INVALID', 'PDM branch names must be unique.');
    if (!versions.has(branch.headVersionId)) fail('PDM_GRAPH_INVALID', `Branch "${branch.name}" has a missing head version.`);
    names.add(folded);
    branches.set(branch.id, branch);
  }
  if (!branches.has(graph.activeBranchId)) fail('PDM_GRAPH_INVALID', 'PDM active branch is missing.');
  return { graph, branches, versions };
}

function graphFrom(project) {
  return validateGraph(project?.extensions?.pdm);
}

function nextId(graph, kind) {
  graph.sequence++;
  return `${kind}-${String(graph.sequence).padStart(6, '0')}`;
}

function transition(version, state, input, code) {
  version.state = state;
  version.transitions.push({
    sequence: version.transitions.length + 1,
    from: version.transitions.at(-1)?.to || null,
    to: state,
    actor: actor(input.actor),
    at: instant(input.at),
    ...(input.comment ? { comment: requiredText(input.comment, 'Transition comment', 1000) } : {}),
    code,
  });
}

export function initializeStudioPdm(project, input = {}) {
  if (project?.extensions?.pdm) fail('PDM_ALREADY_INITIALIZED', 'Project PDM is already initialized.');
  const snapshot = contentSnapshot(project);
  const createdBy = actor(input.actor);
  const createdAt = instant(input.at);
  const branchName = input.branchName == null ? 'main' : requiredText(input.branchName, 'Branch name', 100);
  if (!BRANCH_NAME.test(branchName)) fail('PDM_INPUT_INVALID', 'Branch name contains unsupported characters.');
  const version = {
    id: 'version-000001',
    branchId: 'branch-000001',
    parentVersionIds: [],
    documentHash: studioV5CanonicalHash(snapshot),
    snapshot,
    message: requiredText(input.message || 'Initial controlled version', 'Version message', 500),
    createdBy,
    createdAt,
    state: 'work-in-progress',
    reviewRound: 0,
    approvals: [],
    transitions: [{ sequence: 1, from: null, to: 'work-in-progress', actor: createdBy, at: createdAt, code: 'created' }],
  };
  const graph = {
    schema: STUDIO_PDM_SCHEMA,
    sequence: 1,
    activeBranchId: 'branch-000001',
    branches: [{
      id: 'branch-000001', name: branchName, headVersionId: version.id,
      createdFromVersionId: version.id, createdBy, createdAt,
    }],
    versions: [version],
  };
  return attach(project, graph);
}

export function createStudioPdmVersion(project, input = {}) {
  const { graph, branches, versions } = graphFrom(project);
  const branch = branches.get(input.branchId || graph.activeBranchId);
  if (!branch) fail('PDM_BRANCH_NOT_FOUND', 'Requested PDM branch does not exist.');
  if (branch.id !== graph.activeBranchId) fail('PDM_BRANCH_NOT_ACTIVE', 'Create a version on the active checked-out branch.');
  if (input.expectedHeadVersionId !== branch.headVersionId) fail('PDM_HEAD_CONFLICT', 'Branch head changed before version creation.', { expected: input.expectedHeadVersionId, actual: branch.headVersionId });
  const parent = versions.get(branch.headVersionId);
  verifySnapshot(parent);
  const snapshot = contentSnapshot(project);
  const documentHash = studioV5CanonicalHash(snapshot);
  if (documentHash === parent.documentHash) fail('PDM_NO_CHANGES', 'Working document matches the current branch head.');
  const createdBy = actor(input.actor);
  const createdAt = instant(input.at);
  const version = {
    id: nextId(graph, 'version'),
    branchId: branch.id,
    parentVersionIds: [parent.id],
    documentHash,
    snapshot,
    message: requiredText(input.message, 'Version message', 500),
    createdBy,
    createdAt,
    state: 'work-in-progress',
    reviewRound: 0,
    approvals: [],
    transitions: [{ sequence: 1, from: null, to: 'work-in-progress', actor: createdBy, at: createdAt, code: 'created' }],
  };
  graph.versions.push(version);
  graph.branches.find((entry) => entry.id === branch.id).headVersionId = version.id;
  return attach(project, graph);
}

export function createStudioPdmBranch(project, input = {}) {
  const { graph, versions } = graphFrom(project);
  const name = requiredText(input.name, 'Branch name', 100);
  if (!BRANCH_NAME.test(name)) fail('PDM_INPUT_INVALID', 'Branch name contains unsupported characters.');
  if (graph.branches.some((branch) => branch.name.toLowerCase() === name.toLowerCase())) fail('PDM_BRANCH_EXISTS', `Branch "${name}" already exists.`);
  const fromVersionId = input.fromVersionId || graph.branches.find((branch) => branch.id === graph.activeBranchId)?.headVersionId;
  const from = versions.get(fromVersionId);
  if (!from) fail('PDM_VERSION_NOT_FOUND', 'Branch source version does not exist.');
  verifySnapshot(from);
  const branch = {
    id: nextId(graph, 'branch'),
    name,
    headVersionId: from.id,
    createdFromVersionId: from.id,
    createdBy: actor(input.actor),
    createdAt: instant(input.at),
  };
  graph.branches.push(branch);
  if (input.checkout === true) graph.activeBranchId = branch.id;
  const base = input.checkout === true ? verifySnapshot(from) : project;
  return attach(base, graph);
}

export function checkoutStudioPdmBranch(project, branchId) {
  const { graph, branches, versions } = graphFrom(project);
  const branch = branches.get(String(branchId || ''));
  if (!branch) fail('PDM_BRANCH_NOT_FOUND', 'Requested PDM branch does not exist.');
  const snapshot = verifySnapshot(versions.get(branch.headVersionId));
  graph.activeBranchId = branch.id;
  return attach(snapshot, graph);
}

export function submitStudioPdmReview(project, input = {}) {
  const { graph, versions } = graphFrom(project);
  const version = versions.get(String(input.versionId || ''));
  if (!version) fail('PDM_VERSION_NOT_FOUND', 'Requested PDM version does not exist.');
  if (version.state !== 'work-in-progress') fail('PDM_STATE_INVALID', 'Only work-in-progress versions can enter review.');
  verifySnapshot(version);
  version.reviewRound++;
  transition(version, 'in-review', input, 'submitted-for-review');
  graph.versions = [...versions.values()];
  return attach(project, graph);
}

export function recordStudioPdmApproval(project, input = {}) {
  const { graph, versions } = graphFrom(project);
  const version = versions.get(String(input.versionId || ''));
  if (!version) fail('PDM_VERSION_NOT_FOUND', 'Requested PDM version does not exist.');
  if (version.state !== 'in-review') fail('PDM_STATE_INVALID', 'Approvals can only be recorded during review.');
  const reviewer = actor(input.reviewer, 'Reviewer');
  if (reviewer === version.createdBy) fail('PDM_SELF_APPROVAL_DENIED', 'Version author cannot approve their own version.');
  const decision = String(input.decision || '');
  if (decision !== 'approved' && decision !== 'rejected') fail('PDM_INPUT_INVALID', 'Approval decision must be approved or rejected.');
  if (version.approvals.some((entry) => entry.reviewRound === version.reviewRound && entry.reviewer === reviewer)) fail('PDM_DUPLICATE_REVIEW', 'Reviewer already recorded a decision in this review round.');
  version.approvals.push({
    sequence: version.approvals.length + 1,
    reviewRound: version.reviewRound,
    reviewer,
    decision,
    at: instant(input.at),
    ...(input.comment ? { comment: requiredText(input.comment, 'Approval comment', 1000) } : {}),
  });
  graph.versions = [...versions.values()];
  return attach(project, graph);
}

export function returnStudioPdmForChanges(project, input = {}) {
  const { graph, versions } = graphFrom(project);
  const version = versions.get(String(input.versionId || ''));
  if (!version) fail('PDM_VERSION_NOT_FOUND', 'Requested PDM version does not exist.');
  if (version.state !== 'in-review') fail('PDM_STATE_INVALID', 'Only an in-review version can return for changes.');
  const current = version.approvals.filter((entry) => entry.reviewRound === version.reviewRound);
  if (!current.some((entry) => entry.decision === 'rejected')) fail('PDM_REJECTION_REQUIRED', 'Return for changes requires a recorded rejection.');
  transition(version, 'work-in-progress', input, 'returned-for-changes');
  graph.versions = [...versions.values()];
  return attach(project, graph);
}

export function releaseStudioPdmVersion(project, input = {}) {
  const { graph, versions } = graphFrom(project);
  const version = versions.get(String(input.versionId || ''));
  if (!version) fail('PDM_VERSION_NOT_FOUND', 'Requested PDM version does not exist.');
  if (version.state !== 'in-review') fail('PDM_STATE_INVALID', 'Only an in-review version can be released.');
  verifySnapshot(version);
  const current = version.approvals.filter((entry) => entry.reviewRound === version.reviewRound);
  const requiredApprovals = Number.isInteger(input.requiredApprovals) ? input.requiredApprovals : 1;
  if (requiredApprovals < 1 || requiredApprovals > 20) fail('PDM_INPUT_INVALID', 'Required approvals must be between 1 and 20.');
  if (current.some((entry) => entry.decision === 'rejected')) fail('PDM_REVIEW_REJECTED', 'Rejected review cannot be released.');
  if (current.filter((entry) => entry.decision === 'approved').length < requiredApprovals) fail('PDM_APPROVAL_REQUIRED', `Release requires ${requiredApprovals} current-round approval(s).`);
  transition(version, 'released', input, 'released');
  graph.versions = [...versions.values()];
  return attach(project, graph);
}

export function obsoleteStudioPdmVersion(project, input = {}) {
  const { graph, versions } = graphFrom(project);
  const version = versions.get(String(input.versionId || ''));
  if (!version) fail('PDM_VERSION_NOT_FOUND', 'Requested PDM version does not exist.');
  if (version.state !== 'released') fail('PDM_STATE_INVALID', 'Only a released version can become obsolete.');
  transition(version, 'obsolete', input, 'obsolete');
  graph.versions = [...versions.values()];
  return attach(project, graph);
}

export function inspectStudioPdm(project) {
  const { graph } = graphFrom(project);
  return graph;
}
