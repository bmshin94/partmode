/**
 * @typedef {{ featureId: string, signature: string }} StudioActiveFeatureDescriptor
 * @typedef {{ featureId: string, signature: string, [key: string]: unknown }} StudioFeatureCheckpointDescriptor
 * @typedef {{
 *   reusablePrefixLength: number,
 *   restoreCheckpoint: StudioFeatureCheckpointDescriptor | null,
 *   reusedFeatureIds: string[],
 *   evaluatedFeatureIds: string[],
 * }} StudioFeatureRebuildPlan
 */

export class StudioFeatureRebuildPlanError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'StudioFeatureRebuildPlanError';
    this.code = 'INVALID_ACTIVE_FEATURE_SEQUENCE';
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonemptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * Active features are document state, not an optional cache. Reject an invalid
 * sequence instead of producing an evaluation order whose feature identity is
 * ambiguous.
 *
 * @param {unknown} value
 * @returns {StudioActiveFeatureDescriptor[]}
 */
function validateActiveFeatures(value) {
  if (!Array.isArray(value)) throw new StudioFeatureRebuildPlanError('Active features must be an ordered array.');
  const ids = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = value[index];
    if (!isRecord(descriptor) || !isNonemptyString(descriptor.featureId) || !isNonemptyString(descriptor.signature)) {
      throw new StudioFeatureRebuildPlanError('Active feature descriptor ' + index + ' is malformed.');
    }
    if (ids.has(descriptor.featureId)) {
      throw new StudioFeatureRebuildPlanError('Active feature ID "' + descriptor.featureId + '" is duplicated.');
    }
    ids.add(descriptor.featureId);
  }
  return /** @type {StudioActiveFeatureDescriptor[]} */ (value);
}

/**
 * Prior checkpoints are only an optimization. Any malformed entry or repeated
 * feature ID invalidates the complete cache sequence so a valid-looking early
 * checkpoint cannot hide corruption later in the list.
 *
 * @param {unknown} value
 * @returns {StudioFeatureCheckpointDescriptor[] | null}
 */
function validatePriorCheckpoints(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const ids = new Set();
  for (const descriptor of value) {
    if (!isRecord(descriptor) || !isNonemptyString(descriptor.featureId) || !isNonemptyString(descriptor.signature)) return null;
    if (ids.has(descriptor.featureId)) return null;
    ids.add(descriptor.featureId);
  }
  return /** @type {StudioFeatureCheckpointDescriptor[]} */ (value);
}

/**
 * @param {StudioActiveFeatureDescriptor[]} activeFeatures
 * @returns {StudioFeatureRebuildPlan}
 */
function coldPlan(activeFeatures) {
  return {
    reusablePrefixLength: 0,
    restoreCheckpoint: null,
    reusedFeatureIds: [],
    evaluatedFeatureIds: activeFeatures.map((feature) => feature.featureId),
  };
}

/**
 * Find the longest exact prefix shared by the current active feature sequence
 * and the previous checkpoint sequence. Reuse stops at the first ID or
 * signature mismatch. A later matching checkpoint is never considered.
 *
 * @param {unknown} activeFeatureDescriptors
 * @param {unknown} [priorCheckpointDescriptors]
 * @returns {StudioFeatureRebuildPlan}
 */
export function planStudioFeatureRebuild(activeFeatureDescriptors, priorCheckpointDescriptors = []) {
  const activeFeatures = validateActiveFeatures(activeFeatureDescriptors);
  const priorCheckpoints = validatePriorCheckpoints(priorCheckpointDescriptors);
  if (!priorCheckpoints?.length || !activeFeatures.length) return coldPlan(activeFeatures);

  const maximumPrefixLength = Math.min(activeFeatures.length, priorCheckpoints.length);
  let reusablePrefixLength = 0;
  while (reusablePrefixLength < maximumPrefixLength) {
    const current = activeFeatures[reusablePrefixLength];
    const previous = priorCheckpoints[reusablePrefixLength];
    if (current.featureId !== previous.featureId || current.signature !== previous.signature) break;
    reusablePrefixLength += 1;
  }

  if (reusablePrefixLength === 0) return coldPlan(activeFeatures);
  return {
    reusablePrefixLength,
    restoreCheckpoint: priorCheckpoints[reusablePrefixLength - 1],
    reusedFeatureIds: activeFeatures.slice(0, reusablePrefixLength).map((feature) => feature.featureId),
    evaluatedFeatureIds: activeFeatures.slice(reusablePrefixLength).map((feature) => feature.featureId),
  };
}
