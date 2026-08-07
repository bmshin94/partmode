// Pure schema-5 part configuration and design-table helpers.
//
// Configuration application deliberately does not prepare or rebuild the
// project. It returns an isolated schema-5 document with only the selected
// part's parameter values and feature suppression flags changed. The regular
// schema boundary and kernel remain the authorities for the resulting model.

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FEATURE_COLUMN_PREFIX = 'feature:';
const FEATURE_COLUMN_SUFFIX = ':suppressed';
const NUMERIC_CELL_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

export const STUDIO_PART_CONFIGURATION_ERROR_CODES = Object.freeze({
  invalidProject: 'INVALID_CONFIGURATION_PROJECT',
  invalidSet: 'INVALID_CONFIGURATION_SET',
  invalidId: 'INVALID_CONFIGURATION_ID',
  invalidName: 'INVALID_CONFIGURATION_NAME',
  duplicateId: 'DUPLICATE_CONFIGURATION_ID',
  duplicateName: 'DUPLICATE_CONFIGURATION_NAME',
  unknownId: 'UNKNOWN_CONFIGURATION_ID',
  unknownPart: 'UNKNOWN_CONFIGURATION_PART',
  duplicatePart: 'DUPLICATE_CONFIGURATION_PART',
  unknownParameter: 'UNKNOWN_CONFIGURATION_PARAMETER',
  duplicateParameter: 'DUPLICATE_CONFIGURATION_PARAMETER',
  invalidParameterValue: 'INVALID_CONFIGURATION_PARAMETER_VALUE',
  cyclicParameterValue: 'CYCLIC_CONFIGURATION_PARAMETER_VALUE',
  unknownFeature: 'UNKNOWN_CONFIGURATION_FEATURE',
  duplicateFeature: 'DUPLICATE_CONFIGURATION_FEATURE',
  invalidSuppression: 'INVALID_CONFIGURATION_SUPPRESSION',
  invalidCsv: 'INVALID_CONFIGURATION_CSV',
  invalidCsvHeader: 'INVALID_CONFIGURATION_CSV_HEADER',
  duplicateCsvColumn: 'DUPLICATE_CONFIGURATION_CSV_COLUMN',
});

export class StudioPartConfigurationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StudioPartConfigurationError';
    this.code = code;
    if (details.path != null) this.path = details.path;
    if (details.partId != null) this.partId = details.partId;
    if (details.configurationId != null) this.configurationId = details.configurationId;
    if (details.parameterName != null) this.parameterName = details.parameterName;
    if (details.featureId != null) this.featureId = details.featureId;
    if (details.row != null) this.row = details.row;
    if (details.column != null) this.column = details.column;
  }
}

function fail(code, message, details) {
  throw new StudioPartConfigurationError(code, message, details);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, path) {
  if (!isRecord(value)) {
    fail(STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet, path + ' must be an object.', { path });
  }
  return value;
}

function requireId(value, path, code = STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidId) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(code, path + ' must be a stable ID using letters, numbers, dot, underscore, colon, or hyphen.', { path });
  }
  return value;
}

function requireConfigurationName(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidName,
      path + ' must be a non-empty configuration name of at most 200 characters.',
      { path },
    );
  }
  return value.trim();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidProject,
      'The configuration input must be structured-cloneable data.',
    );
  }
}

function findPart(project, partId) {
  if (!isRecord(project) || project.schemaVersion !== 5 || !Array.isArray(project.partDefinitions)) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidProject,
      'Part configurations require a schema-5 project with partDefinitions.',
    );
  }
  requireId(partId, 'configurationSet.partId', STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet);
  const matches = project.partDefinitions.filter((part) => isRecord(part) && part.id === partId);
  if (matches.length === 0) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownPart,
      'Configuration part "' + partId + '" does not exist.',
      { partId },
    );
  }
  if (matches.length !== 1) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicatePart,
      'Configuration part ID "' + partId + '" is ambiguous.',
      { partId },
    );
  }
  return matches[0];
}

function collectParameters(project, part) {
  if (!Array.isArray(project.parameters) || !Array.isArray(part.parameters)) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidProject,
      'Schema-5 project and part parameters must be arrays.',
    );
  }
  const inherited = new Map();
  const local = new Map();
  const collect = (entries, target, path) => {
    for (let index = 0; index < entries.length; index++) {
      const parameter = entries[index];
      if (!isRecord(parameter) || typeof parameter.name !== 'string' || !PARAMETER_NAME_PATTERN.test(parameter.name)) {
        fail(
          STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidProject,
          path + '[' + index + '] has an invalid parameter name.',
          { path: path + '[' + index + ']' },
        );
      }
      if (target.has(parameter.name)) {
        fail(
          STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateParameter,
          path + ' repeats parameter "' + parameter.name + '".',
          { path, parameterName: parameter.name },
        );
      }
      target.set(parameter.name, parameter);
    }
  };
  collect(project.parameters, inherited, 'project.parameters');
  collect(part.parameters, local, 'part.parameters');
  return { inherited, local };
}

function collectFeatures(part) {
  if (!Array.isArray(part.features)) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidProject,
      'The configured part must contain a feature array.',
    );
  }
  const features = new Map();
  for (let index = 0; index < part.features.length; index++) {
    const feature = part.features[index];
    if (!isRecord(feature) || typeof feature.id !== 'string' || !ID_PATTERN.test(feature.id)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidProject,
        'part.features[' + index + '] has an invalid feature ID.',
        { path: 'part.features[' + index + ']' },
      );
    }
    if (features.has(feature.id)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateFeature,
        'The configured part repeats feature ID "' + feature.id + '".',
        { featureId: feature.id },
      );
    }
    features.set(feature.id, feature);
  }
  return features;
}

function normalizeParameterValue(value, path, details) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidParameterValue,
        path + ' must be finite.',
        { ...details, path },
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidParameterValue,
      path + ' must be a finite number or supported expression.',
      { ...details, path },
    );
  }
  return value.trim();
}

function overrideEntries(value, descriptor) {
  if (value == null) return [];
  if (isRecord(value)) return Object.entries(value);
  if (!Array.isArray(value)) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet,
      descriptor.path + ' must be an object or an override-entry array.',
      { path: descriptor.path },
    );
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry[descriptor.key] !== 'string' || !Object.hasOwn(entry, descriptor.valueKey)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet,
        descriptor.path + '[' + index + '] is malformed.',
        { path: descriptor.path + '[' + index + ']' },
      );
    }
    return [entry[descriptor.key], entry[descriptor.valueKey]];
  });
}

function normalizeParameterOverrides(value, configurationId, localParameters) {
  const path = 'configuration[' + configurationId + '].parameterOverrides';
  const entries = overrideEntries(value, {
    path,
    key: 'parameterName',
    valueKey: 'value',
  });
  const overrides = new Map();
  for (const [parameterName, rawValue] of entries) {
    if (typeof parameterName !== 'string' || !PARAMETER_NAME_PATTERN.test(parameterName)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownParameter,
        path + ' contains invalid parameter name "' + String(parameterName) + '".',
        { configurationId, parameterName: String(parameterName), path },
      );
    }
    if (overrides.has(parameterName)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateParameter,
        path + ' repeats parameter "' + parameterName + '".',
        { configurationId, parameterName, path },
      );
    }
    if (!localParameters.has(parameterName)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownParameter,
        'Configuration "' + configurationId + '" targets unknown part parameter "' + parameterName + '".',
        { configurationId, parameterName, path },
      );
    }
    overrides.set(parameterName, normalizeParameterValue(rawValue, path + '.' + parameterName, {
      configurationId,
      parameterName,
    }));
  }
  return Object.fromEntries([...overrides].sort(([left], [right]) => compareText(left, right)));
}

function normalizeFeatureOverrides(value, configurationId, features) {
  const path = 'configuration[' + configurationId + '].featureSuppressionOverrides';
  const entries = overrideEntries(value, {
    path,
    key: 'featureId',
    valueKey: 'suppressed',
  });
  const overrides = new Map();
  for (const [featureId, suppressed] of entries) {
    if (typeof featureId !== 'string' || !ID_PATTERN.test(featureId) || !features.has(featureId)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownFeature,
        'Configuration "' + configurationId + '" targets unknown feature "' + String(featureId) + '".',
        { configurationId, featureId: String(featureId), path },
      );
    }
    if (overrides.has(featureId)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateFeature,
        path + ' repeats feature "' + featureId + '".',
        { configurationId, featureId, path },
      );
    }
    if (typeof suppressed !== 'boolean') {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSuppression,
        path + '.' + featureId + ' must be true or false.',
        { configurationId, featureId, path },
      );
    }
    overrides.set(featureId, suppressed);
  }
  return Object.fromEntries([...overrides].sort(([left], [right]) => compareText(left, right)));
}

function compileExpression(value, allowedNames, path, details) {
  if (typeof value === 'number') return { dependencies: new Set(), evaluate: () => value };
  const source = value;
  const dependencies = new Set();
  let index = 0;
  const invalid = (message, code = STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidParameterValue) => {
    fail(code, path + ' ' + message, { ...details, path });
  };
  const skip = () => {
    while (/\s/u.test(source[index] || '')) index++;
  };
  function factor() {
    skip();
    if (source[index] === '(') {
      index++;
      const inner = expression();
      skip();
      if (source[index] !== ')') invalid('has an unmatched parenthesis.');
      index++;
      return inner;
    }
    if (source[index] === '-' || source[index] === '+') {
      const sign = source[index++] === '-' ? -1 : 1;
      const operand = factor();
      return (resolve) => sign * operand(resolve);
    }
    let match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(source.slice(index));
    if (match) {
      const name = match[0];
      if (!allowedNames.has(name)) {
        fail(
          STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownParameter,
          path + ' references unknown parameter "' + name + '".',
          { ...details, parameterName: name, path },
        );
      }
      dependencies.add(name);
      index += name.length;
      return (resolve) => resolve(name);
    }
    match = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(source.slice(index));
    if (!match) invalid('contains unsupported expression syntax.');
    index += match[0].length;
    const number = Number(match[0]);
    return () => number;
  }
  function term() {
    let evaluate = factor();
    for (;;) {
      skip();
      const operator = source[index];
      if (operator !== '*' && operator !== '/') return evaluate;
      index++;
      const left = evaluate;
      const right = factor();
      evaluate = operator === '*'
        ? (resolve) => left(resolve) * right(resolve)
        : (resolve) => left(resolve) / right(resolve);
    }
  }
  function expression() {
    let evaluate = term();
    for (;;) {
      skip();
      const operator = source[index];
      if (operator !== '+' && operator !== '-') return evaluate;
      index++;
      const left = evaluate;
      const right = term();
      evaluate = operator === '+'
        ? (resolve) => left(resolve) + right(resolve)
        : (resolve) => left(resolve) - right(resolve);
    }
  }
  const evaluate = expression();
  skip();
  if (index !== source.length) invalid('contains unsupported expression syntax.');
  return { dependencies, evaluate };
}

function validateResolvedParameterValues(configuration, parameterContext) {
  const definitions = new Map();
  for (const [name, parameter] of parameterContext.inherited) definitions.set(name, parameter.value);
  for (const [name, parameter] of parameterContext.local) definitions.set(name, parameter.value);
  for (const [name, value] of Object.entries(configuration.parameterOverrides)) definitions.set(name, value);
  const allowedNames = new Set(definitions.keys());
  const compiled = new Map();
  for (const [name, value] of definitions) {
    const path = 'configuration[' + configuration.id + '].resolvedParameters.' + name;
    const normalized = normalizeParameterValue(value, path, {
      configurationId: configuration.id,
      parameterName: name,
    });
    compiled.set(name, compileExpression(normalized, allowedNames, path, {
      configurationId: configuration.id,
      parameterName: name,
    }));
  }
  const resolved = new Map();
  const visiting = new Set();
  const resolve = (name) => {
    if (resolved.has(name)) return resolved.get(name);
    if (visiting.has(name)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.cyclicParameterValue,
        'Configuration "' + configuration.id + '" introduces a parameter cycle at "' + name + '".',
        { configurationId: configuration.id, parameterName: name },
      );
    }
    visiting.add(name);
    const value = compiled.get(name).evaluate(resolve);
    visiting.delete(name);
    if (!Number.isFinite(value)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidParameterValue,
        'Configuration "' + configuration.id + '" resolves parameter "' + name + '" to a non-finite value.',
        { configurationId: configuration.id, parameterName: name },
      );
    }
    resolved.set(name, value);
    return value;
  };
  for (const name of compiled.keys()) resolve(name);
}

function normalizeColumnList(value, descriptor, available) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet,
      descriptor.path + ' must be an array.',
      { path: descriptor.path },
    );
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    const name = value[index];
    if (typeof name !== 'string' || !available.has(name)) {
      fail(
        descriptor.unknownCode,
        descriptor.path + '[' + index + '] references unknown ' + descriptor.label + ' "' + String(name) + '".',
        { path: descriptor.path + '[' + index + ']', [descriptor.detailKey]: String(name) },
      );
    }
    if (seen.has(name)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateCsvColumn,
        descriptor.path + ' repeats column "' + name + '".',
        { path: descriptor.path, [descriptor.detailKey]: name },
      );
    }
    seen.add(name);
  }
  return [...seen].sort(compareText);
}

/**
 * Validate and canonicalize a configuration set without changing either input.
 * Overrides may be maps or entry arrays; the result always contains sorted maps
 * and sorted configuration/column arrays.
 */
export function normalizeStudioPartConfigurationSet(project, input) {
  const set = requireRecord(input, 'configurationSet');
  const partId = requireId(set.partId, 'configurationSet.partId', STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet);
  const part = findPart(project, partId);
  const parameterContext = collectParameters(project, part);
  const features = collectFeatures(part);
  if (!Array.isArray(set.configurations) || set.configurations.length === 0) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet,
      'configurationSet.configurations must contain at least one configuration.',
      { path: 'configurationSet.configurations' },
    );
  }
  const configurations = [];
  const configurationIds = new Set();
  const configurationNames = new Set();
  for (let index = 0; index < set.configurations.length; index++) {
    const path = 'configurationSet.configurations[' + index + ']';
    const raw = requireRecord(set.configurations[index], path);
    const id = requireId(raw.id, path + '.id');
    const name = requireConfigurationName(raw.name, path + '.name');
    if (configurationIds.has(id)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateId,
        'Configuration ID "' + id + '" is duplicated.',
        { configurationId: id, path },
      );
    }
    if (configurationNames.has(name)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateName,
        'Configuration name "' + name + '" is duplicated.',
        { configurationId: id, path },
      );
    }
    configurationIds.add(id);
    configurationNames.add(name);
    const configuration = {
      id,
      name,
      parameterOverrides: normalizeParameterOverrides(raw.parameterOverrides, id, parameterContext.local),
      featureSuppressionOverrides: normalizeFeatureOverrides(raw.featureSuppressionOverrides, id, features),
    };
    validateResolvedParameterValues(configuration, parameterContext);
    configurations.push(configuration);
  }
  configurations.sort((left, right) => compareText(left.id, right.id));

  const activeConfigurationId = requireId(
    set.activeConfigurationId,
    'configurationSet.activeConfigurationId',
  );
  if (!configurationIds.has(activeConfigurationId)) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownId,
      'Active configuration ID "' + activeConfigurationId + '" does not exist.',
      { configurationId: activeConfigurationId },
    );
  }

  const parameterColumns = new Set(normalizeColumnList(set.parameterColumns, {
    path: 'configurationSet.parameterColumns',
    unknownCode: STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownParameter,
    label: 'part parameter',
    detailKey: 'parameterName',
  }, parameterContext.local));
  const featureSuppressionColumns = new Set(normalizeColumnList(set.featureSuppressionColumns, {
    path: 'configurationSet.featureSuppressionColumns',
    unknownCode: STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownFeature,
    label: 'feature',
    detailKey: 'featureId',
  }, features));
  for (const configuration of configurations) {
    for (const name of Object.keys(configuration.parameterOverrides)) parameterColumns.add(name);
    for (const id of Object.keys(configuration.featureSuppressionOverrides)) featureSuppressionColumns.add(id);
  }

  return {
    partId,
    activeConfigurationId,
    configurations,
    parameterColumns: [...parameterColumns].sort(compareText),
    featureSuppressionColumns: [...featureSuppressionColumns].sort(compareText),
  };
}

/** Apply one exact configuration ID to an isolated clone of the project. */
export function applyStudioPartConfiguration(project, configurationSet, configurationId = configurationSet?.activeConfigurationId) {
  const normalized = normalizeStudioPartConfigurationSet(project, configurationSet);
  requireId(configurationId, 'configurationId');
  const configuration = normalized.configurations.find((entry) => entry.id === configurationId);
  if (!configuration) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownId,
      'Configuration ID "' + configurationId + '" does not exist.',
      { configurationId },
    );
  }
  const output = clone(project);
  const part = findPart(output, normalized.partId);
  const parameters = new Map(part.parameters.map((parameter) => [parameter.name, parameter]));
  for (const [name, value] of Object.entries(configuration.parameterOverrides)) parameters.get(name).value = value;
  const features = new Map(part.features.map((feature) => [feature.id, feature]));
  for (const [featureId, suppressed] of Object.entries(configuration.featureSuppressionOverrides)) {
    features.get(featureId).suppressed = suppressed;
  }
  return {
    project: output,
    configuration: clone(configuration),
    partId: normalized.partId,
  };
}

function hashName32(source, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    hash ^= code & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= code >>> 8;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Stable default identity for a CSV row that provides only a configuration name. */
export function studioPartConfigurationIdFromName(name) {
  const normalized = requireConfigurationName(name, 'Configuration');
  return 'configuration-' + hashName32(normalized, 0x811c9dc5) + hashName32(normalized, 0x9e3779b9);
}

function parseCsvRecords(source) {
  if (typeof source !== 'string' || source.length === 0) {
    fail(STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidCsv, 'The design table CSV is empty.');
  }
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let endedRecord = false;
  const finishField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
  };
  const finishRecord = () => {
    finishField();
    rows.push(row);
    row = [];
    endedRecord = true;
  };
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    endedRecord = false;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (afterQuote) {
      if (character === ',') {
        finishField();
        continue;
      }
      if (character === '\r' || character === '\n') {
        if (character === '\r' && source[index + 1] === '\n') index++;
        finishRecord();
        continue;
      }
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidCsv,
        'A quoted CSV field has characters after its closing quote.',
        { row: rows.length + 1, column: row.length + 1 },
      );
    }
    if (character === '"') {
      if (field.length !== 0) {
        fail(
          STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidCsv,
          'A CSV quote may appear only at the start of a field.',
          { row: rows.length + 1, column: row.length + 1 },
        );
      }
      quoted = true;
      continue;
    }
    if (character === ',') {
      finishField();
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index++;
      finishRecord();
      continue;
    }
    field += character;
  }
  if (quoted) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidCsv,
      'The design table CSV ends inside a quoted field.',
      { row: rows.length + 1, column: row.length + 1 },
    );
  }
  if (!endedRecord || field.length || row.length) finishRecord();
  return rows;
}

function configurationIdMap(value) {
  if (value == null) return new Map();
  const entries = value instanceof Map
    ? [...value.entries()]
    : isRecord(value)
      ? Object.entries(value)
      : null;
  if (!entries) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet,
      'configurationIdsByName must be a Map or object.',
      { path: 'configurationIdsByName' },
    );
  }
  const result = new Map();
  for (const [name, id] of entries) {
    const normalizedName = requireConfigurationName(name, 'configurationIdsByName name');
    const normalizedId = requireId(id, 'configurationIdsByName.' + normalizedName);
    if (result.has(normalizedName)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateName,
        'configurationIdsByName repeats configuration name "' + normalizedName + '".',
      );
    }
    result.set(normalizedName, normalizedId);
  }
  return result;
}

function parseCsvParameterValue(cell, row, column) {
  const value = cell.trim();
  if (!value) return undefined;
  if (NUMERIC_CELL_PATTERN.test(value)) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidParameterValue,
        'CSV parameter override must be finite.',
        { row, column },
      );
    }
    return Object.is(number, -0) ? 0 : number;
  }
  return value;
}

/**
 * Parse an RFC4180-style design table. The first column contains configuration
 * names. Exact IDs may be supplied through `configurationIdsByName`; otherwise
 * a stable ID is derived from the exact normalized name.
 */
export function parseStudioPartDesignTable(source, options) {
  const input = requireRecord(options, 'designTableOptions');
  const project = input.project;
  const partId = requireId(input.partId, 'designTableOptions.partId', STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSet);
  const part = findPart(project, partId);
  const parameterContext = collectParameters(project, part);
  const features = collectFeatures(part);
  const rows = parseCsvRecords(source);
  const header = rows[0];
  if (header[0]?.replace(/^\uFEFF/u, '') !== 'Configuration') {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidCsvHeader,
      'The first design table column must be exactly "Configuration".',
      { row: 1, column: 1 },
    );
  }
  header[0] = 'Configuration';
  const columns = [];
  const parameterColumns = [];
  const featureSuppressionColumns = [];
  const seenColumns = new Set(['Configuration']);
  for (let index = 1; index < header.length; index++) {
    const name = header[index];
    if (!name || seenColumns.has(name)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateCsvColumn,
        'Design table column "' + String(name) + '" is empty or duplicated.',
        { row: 1, column: index + 1 },
      );
    }
    seenColumns.add(name);
    if (name.startsWith(FEATURE_COLUMN_PREFIX) && name.endsWith(FEATURE_COLUMN_SUFFIX)) {
      const featureId = name.slice(FEATURE_COLUMN_PREFIX.length, -FEATURE_COLUMN_SUFFIX.length);
      if (!features.has(featureId)) {
        fail(
          STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownFeature,
          'Design table column references unknown feature "' + featureId + '".',
          { featureId, row: 1, column: index + 1 },
        );
      }
      columns.push({ kind: 'feature', featureId });
      featureSuppressionColumns.push(featureId);
    } else {
      if (!PARAMETER_NAME_PATTERN.test(name) || !parameterContext.local.has(name)) {
        fail(
          STUDIO_PART_CONFIGURATION_ERROR_CODES.unknownParameter,
          'Design table column references unknown part parameter "' + name + '".',
          { parameterName: name, row: 1, column: index + 1 },
        );
      }
      columns.push({ kind: 'parameter', parameterName: name });
      parameterColumns.push(name);
    }
  }
  if (rows.length < 2) {
    fail(
      STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidCsv,
      'The design table must contain at least one configuration row.',
    );
  }
  const idsByName = configurationIdMap(input.configurationIdsByName);
  const configurations = [];
  const seenNames = new Set();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (row.length !== header.length) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidCsv,
        'Design table row ' + (rowIndex + 1) + ' has ' + row.length + ' fields; expected ' + header.length + '.',
        { row: rowIndex + 1 },
      );
    }
    const name = requireConfigurationName(row[0], 'designTable[' + (rowIndex + 1) + '].Configuration');
    if (seenNames.has(name)) {
      fail(
        STUDIO_PART_CONFIGURATION_ERROR_CODES.duplicateName,
        'Design table repeats configuration name "' + name + '".',
        { row: rowIndex + 1 },
      );
    }
    seenNames.add(name);
    const id = idsByName.get(name) || studioPartConfigurationIdFromName(name);
    const parameterOverrides = {};
    const featureSuppressionOverrides = {};
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const descriptor = columns[columnIndex];
      const cell = row[columnIndex + 1];
      if (descriptor.kind === 'parameter') {
        const value = parseCsvParameterValue(cell, rowIndex + 1, columnIndex + 2);
        if (value !== undefined) parameterOverrides[descriptor.parameterName] = value;
      } else if (cell.trim()) {
        const value = cell.trim().toLowerCase();
        if (value !== 'true' && value !== 'false') {
          fail(
            STUDIO_PART_CONFIGURATION_ERROR_CODES.invalidSuppression,
            'Feature suppression cells must be empty, true, or false.',
            { featureId: descriptor.featureId, row: rowIndex + 1, column: columnIndex + 2 },
          );
        }
        featureSuppressionOverrides[descriptor.featureId] = value === 'true';
      }
    }
    configurations.push({ id, name, parameterOverrides, featureSuppressionOverrides });
  }
  const sortedIds = configurations.map((configuration) => configuration.id).sort(compareText);
  const activeConfigurationId = input.activeConfigurationId ?? sortedIds[0];
  return normalizeStudioPartConfigurationSet(project, {
    partId,
    activeConfigurationId,
    configurations,
    parameterColumns,
    featureSuppressionColumns,
  });
}

function encodeCsvField(value) {
  const text = String(value);
  return /[",\r\n]/u.test(text)
    ? '"' + text.replace(/"/gu, '""') + '"'
    : text;
}

function serializeParameterValue(value) {
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
  return value;
}

/** Serialize a canonical RFC4180 design table with CRLF records. */
export function serializeStudioPartDesignTable(project, configurationSet) {
  const normalized = normalizeStudioPartConfigurationSet(project, configurationSet);
  const header = [
    'Configuration',
    ...normalized.parameterColumns,
    ...normalized.featureSuppressionColumns.map((featureId) => FEATURE_COLUMN_PREFIX + featureId + FEATURE_COLUMN_SUFFIX),
  ];
  const records = [header];
  for (const configuration of normalized.configurations) {
    records.push([
      configuration.name,
      ...normalized.parameterColumns.map((name) => Object.hasOwn(configuration.parameterOverrides, name)
        ? serializeParameterValue(configuration.parameterOverrides[name])
        : ''),
      ...normalized.featureSuppressionColumns.map((featureId) => Object.hasOwn(configuration.featureSuppressionOverrides, featureId)
        ? String(configuration.featureSuppressionOverrides[featureId])
        : ''),
    ]);
  }
  return records.map((record) => record.map(encodeCsvField).join(',')).join('\r\n') + '\r\n';
}
