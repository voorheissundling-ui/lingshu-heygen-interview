import {createHash} from 'node:crypto';

/** The prepaid wallet and original POST journal froze this representation in
 * their v1 immutable records. A raw-token digest is a separate legacy
 * media-read contract; never accept either digest without choosing a scheme. */
export type ApifyTokenFingerprintScheme='sha256-json-string-v1'|'sha256-raw-v1';
export const APIFY_PREPAID_TOKEN_FINGERPRINT_SCHEME='sha256-json-string-v1' as const;
export function apifyTokenFingerprint(token:string,scheme:ApifyTokenFingerprintScheme):string {
 const bytes=scheme==='sha256-json-string-v1'?JSON.stringify(token):token;
 return createHash('sha256').update(bytes).digest('hex');
}
