export interface PresenterLook {
  id: string; name: string; groupId?: string; voiceId?: string;
  avatarType?: 'digital_twin' | 'photo_avatar' | 'studio_avatar';
  imageUrl?: string; videoUrl?: string;
  gender?: string;
  ethnicity?: string;
  tags?: string[];
  favorite?: boolean;
  orientation: 'unknown' | 'portrait' | 'landscape' | 'square';
  status: string;
}
export interface PresenterVoice { id: string; name: string; language: string; previewUrl?: string; provider?: 'heygen' | 'volcengine_ark' }
export interface PresenterVoiceCandidate extends PresenterVoice { selected?: boolean }
export interface PresenterPage<T> { items: T[]; nextToken: string }
export interface ArkPresenterPreparation {
  photoMaterialId: string;
  videoMaterialId: string;
  /** True only after the user separately consents to Ark processing. */
  processingAuthorized: boolean;
}
export interface PresenterCreation {
  id: string; name: string; type: 'photo' | 'digital_twin'; voiceId?: string;
  status: 'submitting' | 'processing' | 'pending_consent' | 'completed' | 'failed' | 'uncertain';
  look?: PresenterLook; groupId?: string; error?: string; consentUrl?: string;
  failureCategory?: 'capacity' | 'material';
  consentStatus?: string;
  consentRequestedAt?: string;
  arkPreparation?: ArkPresenterPreparation;
  createdAt: string; updatedAt: string;
}
export interface PresenterCapabilities {
  localPhotoUpload?: boolean; configured: boolean; creationEnabled: boolean; directConsent: boolean; privateCatalog: boolean; reason: string;
  photoCreationEnabled?: boolean; digitalTwinCreationEnabled?: boolean; photoCreationReason?: string; digitalTwinCreationReason?: string;
  reservationCny: number | null; photoReservationCny?: number | null; digitalTwinReservationCny?: number | null;
}
