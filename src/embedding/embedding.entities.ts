import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** The tables of task QEMB1. Why each exists, and what the database holds of it, is in
 * `1761500000000-EmbeddingIndex.ts`. */

export type EmbeddingProfileStatus = 'active' | 'retired';

@Entity('embedding_profile')
export class EmbeddingProfile {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'text' }) key: string;
  @Column({ name: 'model_repo', type: 'text' }) modelRepo: string;
  @Column({ type: 'text' }) revision: string;
  @Column({ type: 'text' }) runtime: 'onnx-cpu';
  @Column({ name: 'weights_file', type: 'text' }) weightsFile: string;
  @Column({ name: 'weights_sha256', type: 'text' }) weightsSha256: string;
  @Column({ name: 'tokenizer_sha256', type: 'text' }) tokenizerSha256: string;
  @Column({ type: 'int' }) dimension: number;
  @Column({ type: 'text' }) pooling: 'cls' | 'mean';
  @Column({ type: 'text' }) normalization: 'l2';
  @Column({ type: 'text' }) distance: 'cosine';
  @Column({ name: 'query_prefix', type: 'text' }) queryPrefix: string;
  @Column({ name: 'max_tokens', type: 'int' }) maxTokens: number;
  @Column({ type: 'text' }) language: string;
  @Column({ name: 'chunker_version', type: 'text' }) chunkerVersion: string;
  @Column({ type: 'text' }) license: string;
  @Column({ type: 'text' }) status: EmbeddingProfileStatus;
  @Column({ name: 'approved_by', type: 'text' }) approvedBy: string;
  @Column({ name: 'approved_at', type: 'timestamptz' }) approvedAt: Date;
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' }) createdAt: Date;
}

export type LibrarySourceKind = 'failure_mode' | 'recommendation';

@Entity('library_embedding')
export class LibraryEmbedding {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id', type: 'text' }) tenantId: string;
  @Column({ name: 'profile_id', type: 'uuid' }) profileId: string;
  @Column({ name: 'source_kind', type: 'text' }) sourceKind: LibrarySourceKind;
  @Column({ name: 'failure_mode_id', type: 'uuid', nullable: true }) failureModeId: string | null;
  @Column({ name: 'recommendation_id', type: 'uuid', nullable: true }) recommendationId: string | null;
  @Column({ name: 'input_hash', type: 'text' }) inputHash: string;
  @Column({ type: 'real', array: true }) vector: number[];
  @Column({ name: 'indexed_at', type: 'timestamptz', default: () => 'now()' }) indexedAt: Date;
}

export const EMBEDDING_ENTITIES = [EmbeddingProfile, LibraryEmbedding];
