// ISO 10303-21 FILE_NAME timestamps describe serialization time, not design
// intent. OCCT writes the current wall clock on every export, so normalize that
// one volatile field before STEP bytes leave the kernel worker. A fixed valid
// timestamp removes wall-clock variance without rewriting user-authored
// filename, author, organization, system, or authorization metadata. OCCT may
// still choose different entity ordering for some multi-shape exports.
export const PARTMODE_STEP_CANONICAL_TIMESTAMP = '2000-01-01T00:00:00';

const STEP_QUOTED_STRING = "'(?:[^']|'')*'";
const FILE_NAME_TIMESTAMP = new RegExp(
  `(\\bFILE_NAME\\s*\\(\\s*${STEP_QUOTED_STRING}\\s*,\\s*)(${STEP_QUOTED_STRING})`,
  'gi',
);

function stepHeaderBounds(source) {
  const headerMatches = [...source.matchAll(/\bHEADER\s*;/gi)];
  if (headerMatches.length !== 1) {
    throw new Error(`STEP export must contain exactly one HEADER section; received ${headerMatches.length}.`);
  }
  const headerStart = headerMatches[0].index;
  const endPattern = /\bENDSEC\s*;/gi;
  endPattern.lastIndex = headerStart + headerMatches[0][0].length;
  const headerEndMatch = endPattern.exec(source);
  if (!headerEndMatch) throw new Error('STEP export HEADER section is not terminated by ENDSEC;.');
  return { start: headerStart, end: headerEndMatch.index + headerEndMatch[0].length };
}

export function normalizeStepHeaderText(source) {
  if (typeof source !== 'string') throw new TypeError('STEP export source must be text.');
  const bounds = stepHeaderBounds(source);
  const header = source.slice(bounds.start, bounds.end);
  const matches = [...header.matchAll(FILE_NAME_TIMESTAMP)];
  if (matches.length !== 1) {
    throw new Error(`STEP export HEADER must contain exactly one FILE_NAME entity; received ${matches.length}.`);
  }
  const match = matches[0];
  const timestampToken = match[2];
  const relativeTimestampStart = match.index + match[1].length;
  const timestampStart = bounds.start + relativeTimestampStart;
  return source.slice(0, timestampStart)
    + `'${PARTMODE_STEP_CANONICAL_TIMESTAMP}'`
    + source.slice(timestampStart + timestampToken.length);
}

export async function normalizeStepExportBlob(blob) {
  if (!blob || typeof blob.text !== 'function') throw new TypeError('STEP export must be a Blob.');
  const normalized = normalizeStepHeaderText(await blob.text());
  return new Blob([normalized], { type: blob.type || 'application/STEP' });
}
