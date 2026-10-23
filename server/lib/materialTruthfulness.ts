type MaterialLike = Record<string, unknown>;

function normalized(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Returns true only for explicit test/demo lineage markers. Ordinary display
 * text such as "product demo video" is deliberately not treated as lineage.
 */
export function syntheticMaterialMarker(value: unknown): boolean {
  const marker = normalized(value);
  if (!marker) return false;
  if ([
    'fixture', 'mock', 'placeholder', 'demo', 'sample', 'sample_data',
    'frontend_preview', 'sandbox', 'test', 'test_data', 'e2e',
    'e2e-quality-test',
  ].includes(marker)) return true;
  if (/(^|\/)(?:demo|demos|fixture|fixtures|sample|samples|mock)(?:\/|$)/.test(marker)) return true;
  return /(^|[\/_:.-])(fixture|fixtures|mock|placeholder|frontend_preview|sample|samples|sample_data|demo_seed|demo_data|sandbox|test_data|e2e(?:_quality_test)?)([\/_:.-]|$)/.test(marker);
}

export function isSyntheticMaterial(record: MaterialLike): boolean {
  if ([record.isMock, record.is_mock, record.isDemo, record.is_demo, record.fixture, record.synthetic, record.isTest, record.is_test]
    .some(value => value === true)) return true;

  const name = normalized(record.name);
  if (/^(mock|fixture|placeholder)(?:[\s_.-]|$)/.test(name) || /^示例[·・\s_.-]/.test(name)) return true;

  if (['mock', 'fixture', 'fixtures', 'sample', 'samples', 'demo', 'test', 'e2e'].includes(normalized(record.folder))) return true;

  return [
    record.source, record.sourceType, record.source_type, record.origin,
    record.dataSource, record.data_source, record.provenance,
    record.sourceUrl, record.source_url, record.url, record.file,
    record.objectKey, record.object_key,
  ].some(syntheticMaterialMarker);
}
