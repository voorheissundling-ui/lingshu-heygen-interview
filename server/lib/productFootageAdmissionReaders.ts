/**
 * Stable server-domain read boundary for product-footage admission.
 *
 * Route modules currently own the legacy implementations, but production
 * workflow code must not depend on HTTP adapters directly. Keeping the
 * compatibility re-exports here gives Starter198 a non-route port while the
 * implementation is migrated into a dedicated domain service.
 */
export {
  readApprovedProductFootage,
  type FootageAuthority,
} from '../routes/enterpriseProductFootageReview.js';

export {
  readApprovedProductFootageVisualOverlay,
  type FootageVisualAuthority,
} from '../routes/enterpriseProductFootageVisualReview.js';
