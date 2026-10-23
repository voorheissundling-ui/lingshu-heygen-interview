import {readStoryboardFile, storyboardSummary, STORYBOARD_ASSET_PATH} from './storyboard.js';

const file = process.argv[2] ?? STORYBOARD_ASSET_PATH;
const result = await readStoryboardFile(file, {requireExists: true});
if (!result.ok || !result.storyboard) {
  console.error(JSON.stringify({ok: false, path: file, issues: result.issues}, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  path: file,
  sha256: result.sha256,
  savedAt: result.savedAt,
  summary: storyboardSummary(result.storyboard),
  presenter: {
    provider: result.storyboard.presenter.provider,
    ownership: result.storyboard.presenter.ownership,
    avatarId: result.storyboard.presenter.avatarId,
    voiceId: result.storyboard.presenter.voiceId,
  },
  shots: result.storyboard.shots.map(shot => ({
    id: shot.id,
    kind: shot.kind,
    startSeconds: shot.startSeconds,
    durationSeconds: shot.durationSeconds,
    subtitle: shot.subtitle,
  })),
}, null, 2));
