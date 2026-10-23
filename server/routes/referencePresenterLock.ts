import { validatePresenterRightsEvidence } from '../lib/presenterAssetTrust.js';

type Presenter = Record<string, unknown>;

/** Resolve the enterprise's named sales presenter from its saved, tenant-scoped assets. */
export function resolveReferenceSalesPresenter(rows: Array<{ payload?: { presenters?: Presenter[] } }>):
  { assetId: string; assetVersion: string; rightsVerified: true; rightsEvidenceRef: string } | null {
  if (rows.length !== 1) return null;
  const matches = (rows[0]?.payload?.presenters ?? []).filter(item => String(item.name || '').trim() === '销售');
  if (matches.length !== 1) return null;
  const presenter = matches[0]!;
  const assetId = String(presenter.id || '').trim();
  // Pre-versioned production-default records are treated as V1 throughout the
  // editor and production pipeline; an explicitly invalid version is rejected.
  const version = Number(presenter.assetVersion ?? 1);
  // Production defaults used by the enterprise presenter editor do not carry
  // social-account profile status. The machine-checked consent envelope below
  // is the relevant authorization evidence for this reference handoff.
  if (!assetId || !Number.isSafeInteger(version) || version < 1 || presenter.authorized !== true) return null;
  const routes = [
    { provider: 'heygen' as const, uses: ['digital_presenter', 'voice_synthesis'] as const },
    { provider: 'volcengine_ark' as const, uses: ['person_replacement'] as const },
    { provider: 'dashscope' as const, uses: ['person_replacement'] as const },
  ];
  const verified = routes.some(route => validatePresenterRightsEvidence(presenter.rightsEvidence,
    { provider: route.provider, uses: [...route.uses] }).ok);
  if (!verified) return null;
  const rightsEvidence = presenter.rightsEvidence as { authorizationRef: string };
  return { assetId, assetVersion: String(version), rightsVerified: true,
    rightsEvidenceRef: rightsEvidence.authorizationRef };
}
