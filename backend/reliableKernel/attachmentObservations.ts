import { createHash } from 'node:crypto';
import type { AttachmentCatalogEntry, MessageContent } from '../../shared/protocol';
import {
  ATTACHMENT_OBSERVATION_PROMPT_REVISION,
  type LlmAttachmentObservation,
  type LlmAttachmentObservationRequirement
} from '../world/modules/llm/contracts';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { canonicalPlainJson, normalizePlainJson } from './plainJson';
import type { ModelHandleCatalog } from './modelHandleCatalog';
import { modelHandleRef, prepareModelHandleCatalog } from './modelHandleCatalog';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export const ATTACHMENT_OBSERVATION_CONTENT_TYPE = 'application/vnd.limcode.attachment-observation+json';
export const ATTACHMENT_OBSERVATION_STATE_KIND = 'attachment_observation_state';
export const ATTACHMENT_OBSERVATION_UNAVAILABLE_UNCERTAINTY =
  'Attachment content was not observed; visual or media details remain unknown.';

export interface AttachmentObservationDocument {
  kind: 'attachment_observation';
  analysisProfileSha256: string;
  summary: string;
  salientFacts: string[];
  uncertainties: string[];
}

export interface AttachmentObservationCommit {
  attachmentId: string;
  analysisProfileSha256: string;
  document: AttachmentObservationDocument;
}

export interface AttachmentObservationAnalysisProfileInput {
  providerConfigId: string;
  provider: string;
  modelId: string;
}

export function attachmentObservationAnalysisProfileSha256(
  input: AttachmentObservationAnalysisProfileInput
): string {
  const profile = canonicalPlainJson({
    kind: 'attachment_observation_analysis_profile',
    promptRevision: ATTACHMENT_OBSERVATION_PROMPT_REVISION,
    providerConfigId: requireText(input.providerConfigId, 'providerConfigId'),
    provider: requireText(input.provider, 'provider'),
    modelId: requireText(input.modelId, 'modelId')
  }, 'Attachment observation analysis profile');
  return createHash('sha256').update(profile).digest('hex');
}

export function attachmentObservationLinkId(attachmentIdInput: string, profileSha256Input: string): string {
  const attachmentId = requireText(attachmentIdInput, 'attachmentId');
  const profileSha256 = requireSha256(profileSha256Input, 'analysisProfileSha256');
  return stableId('attachment_observation_link', attachmentId, profileSha256);
}

export function compressionBlockObservationLinkId(
  compressionBlockIdInput: string,
  observationLinkIdInput: string
): string {
  return stableId(
    'compression_block_observation_link',
    requireText(compressionBlockIdInput, 'compressionBlockId'),
    requireText(observationLinkIdInput, 'observationLinkId')
  );
}

export function attachmentObservationDocumentContent(documentInput: AttachmentObservationDocument): string {
  return canonicalPlainJson(
    normalizeAttachmentObservationDocument(documentInput),
    'Attachment observation document'
  );
}

export function renderAttachmentObservationStateContent(
  requirementsInput: readonly LlmAttachmentObservationRequirement[],
  observationsInput: readonly LlmAttachmentObservation[]
): MessageContent {
  const requirements = requirementsInput.map((value, index) =>
    normalizeRequirement(value, `attachmentObservationRequirements[${index}]`)
  );
  const observations = observationsInput.map((value, index) =>
    normalizeLlmAttachmentObservation(value, `attachmentObservations[${index}]`)
  );
  if (requirements.length === 0 || observations.length !== requirements.length) {
    throw new Error('Attachment observation state requires one observation per non-empty requirement.');
  }
  const records = requirements.map((requirement, index) => {
    const observation = observations[index];
    if (!observation || observation.attachmentRef !== requirement.attachmentRef) {
      throw new Error(`Attachment observation state ${index} does not match ${requirement.attachmentRef}.`);
    }
    return {
      attachmentRef: requirement.attachmentRef,
      name: requirement.name,
      mimeType: requirement.mimeType,
      sizeBytes: requirement.sizeBytes,
      summary: observation.summary,
      salientFacts: [...observation.salientFacts],
      uncertainties: [...observation.uncertainties]
    };
  });
  return {
    role: 'user',
    parts: [{ text: canonicalPlainJson({
      kind: ATTACHMENT_OBSERVATION_STATE_KIND,
      promptRevision: ATTACHMENT_OBSERVATION_PROMPT_REVISION,
      observations: records
    }, 'Attachment observation model state') }]
  };
}

export function assertAttachmentObservationStateContent(
  contents: readonly MessageContent[],
  requirements: readonly LlmAttachmentObservationRequirement[],
  observationsInput: readonly unknown[]
): void {
  const observations = observationsInput.map((value, index) =>
    normalizeLlmAttachmentObservation(value, `attachmentObservations[${index}]`)
  );
  const expected = renderAttachmentObservationStateContent(requirements, observations).parts[0];
  if (!expected || !('text' in expected)) throw new Error('Attachment observation state renderer is invalid.');
  let matches = 0;
  for (const content of contents) {
    for (const part of content.parts) {
      if ('text' in part && part.text === expected.text) matches += 1;
    }
  }
  if (matches !== 1) {
    throw new Error('Compression result must contain exactly one canonical Attachment observation state.');
  }
}

export async function loadAttachmentObservationRequirements(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  catalogInput: readonly AttachmentCatalogEntry[],
  modelHandleCatalogInput: ModelHandleCatalog | unknown,
  profileSha256Input: string
): Promise<LlmAttachmentObservationRequirement[]> {
  const profileSha256 = requireSha256(profileSha256Input, 'analysisProfileSha256');
  const catalog = catalogInput.map((entry, index) => normalizeCatalogEntry(entry, index));
  const modelHandleCatalog = prepareModelHandleCatalog(modelHandleCatalogInput);
  if (catalog.length === 0) return [];
  const linkIds = catalog.map((entry) => attachmentObservationLinkId(entry.attachmentId, profileSha256));
  const linkSnapshot = await database.snapshot(linkIds.map((id) =>
    DOMAIN_REPOSITORIES.domain('AttachmentObservationLink').get(id)
  ));
  const contentIds = linkSnapshot.snapshot.map((value, index) => {
    if (value === null) return undefined;
    const row = requireRow(value, `AttachmentObservationLink ${linkIds[index]}`);
    if (row.attachment_id !== catalog[index].attachmentId
      || row.analysis_profile_sha256 !== profileSha256) {
      throw new Error(`AttachmentObservationLink ${linkIds[index]} identity conflicts with its stable key.`);
    }
    return requireText(row.content_object_id, 'AttachmentObservationLink.content_object_id');
  });
  const uniqueContentIds = [...new Set(contentIds.filter((value): value is string => !!value))];
  const contentSnapshot = uniqueContentIds.length > 0
    ? await database.snapshot(uniqueContentIds.map((id) => DOMAIN_REPOSITORIES.domain('ContentObject').get(id)))
    : { snapshot: [] as Array<DomainRow | DomainRow[] | null> };
  const contentRows = new Map<string, DomainRow>();
  uniqueContentIds.forEach((id, index) => {
    const row = requireRow(contentSnapshot.snapshot[index], `ContentObject ${id}`);
    if (row.content_type !== ATTACHMENT_OBSERVATION_CONTENT_TYPE) {
      throw new Error(`Attachment observation ${id} has unexpected content type ${String(row.content_type)}.`);
    }
    contentRows.set(id, row);
  });
  const bytes = uniqueContentIds.length > 0
    ? await contentStore.readMany(uniqueContentIds.map((id) => asContentObjectMetadata(contentRows.get(id)!)))
    : [];
  const documents = new Map<string, AttachmentObservationDocument>();
  uniqueContentIds.forEach((id, index) => {
    const parsed = normalizePlainJson(JSON.parse(bytes[index].toString('utf8')), `Attachment observation ${id}`);
    const document = normalizeAttachmentObservationDocument(parsed);
    if (document.analysisProfileSha256 !== profileSha256) {
      throw new Error(`Attachment observation ${id} analysis profile conflicts with its Link.`);
    }
    documents.set(id, document);
  });

  return catalog.map((entry, index): LlmAttachmentObservationRequirement => {
    const attachmentRef = modelHandleRef(modelHandleCatalog, 'attachment', entry.attachmentId);
    if (!attachmentRef) throw new Error(`Attachment ${entry.attachmentId} has no frozen model handle.`);
    const contentId = contentIds[index];
    const document = contentId ? documents.get(contentId) : undefined;
    return {
      attachmentRef,
      attachmentId: entry.attachmentId,
      name: entry.name,
      mimeType: entry.mimeType,
      sizeBytes: entry.sizeBytes,
      ...(document ? {
        cachedObservation: {
          attachmentRef,
          summary: document.summary,
          salientFacts: [...document.salientFacts],
          uncertainties: [...document.uncertainties]
        }
      } : {})
    };
  });
}

export function completeAttachmentObservationCommits(
  requirementsInput: readonly LlmAttachmentObservationRequirement[],
  observationsInput: unknown,
  profileSha256Input: string
): AttachmentObservationCommit[] {
  const profileSha256 = requireSha256(profileSha256Input, 'analysisProfileSha256');
  if (!Array.isArray(observationsInput)) {
    throw new TypeError('Compression attachmentObservations must be an array.');
  }
  const observations = observationsInput.map((value, index) =>
    normalizeLlmAttachmentObservation(value, `attachmentObservations[${index}]`)
  );
  const byRef = new Map<string, LlmAttachmentObservation>();
  for (const observation of observations) {
    if (byRef.has(observation.attachmentRef)) {
      throw new Error(`Compression returned duplicate attachment observation ${observation.attachmentRef}.`);
    }
    byRef.set(observation.attachmentRef, observation);
  }
  const requirements = requirementsInput.map((value, index) =>
    normalizeRequirement(value, `attachmentObservationRequirements[${index}]`)
  );
  const requiredRefs = new Set<string>();
  const requiredAttachments = new Set<string>();
  for (const requirement of requirements) {
    if (requiredRefs.has(requirement.attachmentRef) || requiredAttachments.has(requirement.attachmentId)) {
      throw new Error('Compression attachment observation requirements contain duplicate identities.');
    }
    requiredRefs.add(requirement.attachmentRef);
    requiredAttachments.add(requirement.attachmentId);
  }
  if (observations.length !== requirements.length) {
    throw new Error('Compression did not return one observation for every required Attachment.');
  }
  return requirements.flatMap((requirement): AttachmentObservationCommit[] => {
    const observation = byRef.get(requirement.attachmentRef);
    if (!observation) {
      throw new Error(`Compression omitted attachment observation ${requirement.attachmentRef}.`);
    }
    // Unavailable results stay in the immutable summary, not in the reusable observation cache.
    if (isUnavailableAttachmentObservation(observation)) return [];
    return [{
      attachmentId: requirement.attachmentId,
      analysisProfileSha256: profileSha256,
      document: {
        kind: 'attachment_observation',
        analysisProfileSha256: profileSha256,
        summary: observation.summary,
        salientFacts: [...observation.salientFacts],
        uncertainties: [...observation.uncertainties]
      }
    }];
  });
}

export function isUnavailableAttachmentObservation(
  observation: Pick<LlmAttachmentObservation, 'uncertainties'>
): boolean {
  return observation.uncertainties.includes(ATTACHMENT_OBSERVATION_UNAVAILABLE_UNCERTAINTY);
}

export function normalizeLlmAttachmentObservation(
  value: unknown,
  label = 'attachmentObservation'
): LlmAttachmentObservation {
  const record = requireRecord(value, label);
  return {
    attachmentRef: requireAttachmentRef(record.attachmentRef, `${label}.attachmentRef`),
    summary: requireBoundedText(record.summary, `${label}.summary`, 8_000),
    salientFacts: normalizeTextList(record.salientFacts, `${label}.salientFacts`, 32, 2_000),
    uncertainties: normalizeTextList(record.uncertainties, `${label}.uncertainties`, 16, 2_000)
  };
}

export function normalizeAttachmentObservationRequirement(
  value: unknown,
  label = 'attachmentObservationRequirement'
): LlmAttachmentObservationRequirement {
  return normalizeRequirement(value, label);
}

function normalizeRequirement(value: unknown, label: string): LlmAttachmentObservationRequirement {
  const record = requireRecord(value, label);
  const sizeBytes = requireNonNegativeInteger(record.sizeBytes, `${label}.sizeBytes`);
  const attachmentRef = requireAttachmentRef(record.attachmentRef, `${label}.attachmentRef`);
  const cached = record.cachedObservation === undefined
    ? undefined
    : normalizeLlmAttachmentObservation(record.cachedObservation, `${label}.cachedObservation`);
  if (cached && cached.attachmentRef !== attachmentRef) {
    throw new Error(`${label}.cachedObservation must use ${attachmentRef}.`);
  }
  return {
    attachmentRef,
    attachmentId: requireText(record.attachmentId, `${label}.attachmentId`),
    name: requireText(record.name, `${label}.name`),
    mimeType: requireText(record.mimeType, `${label}.mimeType`),
    sizeBytes,
    ...(cached ? { cachedObservation: cached } : {})
  };
}

function normalizeAttachmentObservationDocument(value: unknown): AttachmentObservationDocument {
  const record = requireRecord(value, 'Attachment observation document');
  if (record.kind !== 'attachment_observation') {
    throw new TypeError('Attachment observation document.kind is invalid.');
  }
  const document: AttachmentObservationDocument = {
    kind: 'attachment_observation',
    analysisProfileSha256: requireSha256(record.analysisProfileSha256, 'Attachment observation analysisProfileSha256'),
    summary: requireBoundedText(record.summary, 'Attachment observation summary', 8_000),
    salientFacts: normalizeTextList(record.salientFacts, 'Attachment observation salientFacts', 32, 2_000),
    uncertainties: normalizeTextList(record.uncertainties, 'Attachment observation uncertainties', 16, 2_000)
  };
  if (isUnavailableAttachmentObservation(document)) {
    throw new TypeError('Unavailable attachment observations cannot be cached.');
  }
  return document;
}

function normalizeCatalogEntry(value: AttachmentCatalogEntry, index: number): AttachmentCatalogEntry {
  return {
    attachmentId: requireText(value.attachmentId, `attachmentCatalog[${index}].attachmentId`),
    name: requireText(value.name, `attachmentCatalog[${index}].name`),
    mimeType: requireText(value.mimeType, `attachmentCatalog[${index}].mimeType`),
    sizeBytes: requireNonNegativeInteger(value.sizeBytes, `attachmentCatalog[${index}].sizeBytes`)
  };
}

function normalizeTextList(value: unknown, label: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TypeError(`${label} must be an array with at most ${maxItems} items.`);
  }
  return value.map((entry, index) => requireBoundedText(entry, `${label}[${index}]`, maxChars));
}

function requireAttachmentRef(value: unknown, label: string): string {
  const ref = requireText(value, label);
  if (!/^F[1-9]\d*$/.test(ref)) throw new TypeError(`${label} must be an attachment F reference.`);
  return ref;
}

function requireSha256(value: unknown, label: string): string {
  const text = requireText(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} must be a SHA-256 hex digest.`);
  return text;
}

function requireBoundedText(value: unknown, label: string, maxChars: number): string {
  const text = requireText(value, label);
  if (text.length > maxChars) throw new RangeError(`${label} exceeds ${maxChars} characters.`);
  return text;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireRow(value: DomainRow | DomainRow[] | null, label: string): DomainRow {
  if (!value || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return {
    ...row,
    id: requireText(row.id, 'ContentObject.id'),
    sha256: requireText(row.sha256, 'ContentObject.sha256'),
    byte_length: requireBigInt(row.byte_length, 'ContentObject.byte_length'),
    content_type: requireText(row.content_type, 'ContentObject.content_type'),
    storage_key: requireText(row.storage_key, 'ContentObject.storage_key'),
    created_at: requireText(row.created_at, 'ContentObject.created_at')
  };
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative SQLite INTEGER.`);
  return value;
}

function stableId(kind: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update('limcode-attachment-observation\0')
    .update(kind)
    .update('\0')
    .update(parts.join('\0'))
    .digest('hex');
  return `${kind}_${digest}`;
}
