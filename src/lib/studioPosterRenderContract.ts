import type { SocialImageCreationTask } from '../../shared/contracts/socialImageCreation';
import type { Material } from './studioApi';

export interface FbPosterRenderResult {
  ok: boolean;
  task?: SocialImageCreationTask;
  source?: 'openai' | 'qwen' | 'local';
  model?: string;
  url?: string;
  material?: Material;
  references?: number;
  deliverableType?: import('../../shared/imageCreativePlanning').ImageDeliverable;
  productionStrategy?: import('../../shared/imageCreativePlanning').ImageProductionStrategy;
  fieldsToConfirm?: string[];
  qualityStatus?: 'needs_review' | 'needs_confirmation' | 'passed' | 'rejected';
  publishable?: boolean;
  code?: string;  error?: string;
}
