/**
 * Temporary compatibility boundary for frame extraction that is still hosted
 * by the legacy videos HTTP module. Domain workflows import this adapter,
 * keeping the route dependency isolated until the extractor is moved into a
 * dedicated media-analysis service.
 */
export { extractQwenAnalysisFrames } from '../routes/videos.js';
