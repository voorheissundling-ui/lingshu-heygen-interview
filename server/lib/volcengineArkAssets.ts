import { createHash, createHmac } from 'node:crypto';

type ArkAsset = { Id: string; Name?: string; GroupId?: string; AssetType: 'Image' | 'Video' | 'Audio'; Status: 'Active' | 'Processing' | 'Failed'; Error?: { Message?: string } };
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Ark Assets API client. Consent and tenant ownership are enforced by the caller. */
export class VolcengineArkAssets {
  constructor(
    private readonly configuredAccessKey?: string,
    private readonly configuredSecretKey?: string,
    private readonly configuredRegion?: string,
  ) {}
  private credentials() {
    return {
      accessKey: this.configuredAccessKey ?? process.env.VOLCENGINE_ACCESS_KEY_ID ?? '',
      secretKey: this.configuredSecretKey ?? process.env.VOLCENGINE_SECRET_ACCESS_KEY ?? '',
      region: this.configuredRegion ?? process.env.VOLCENGINE_ARK_ASSET_REGION ?? 'cn-beijing',
    };
  }
  configured() {
    const { accessKey, secretKey } = this.credentials();
    return Boolean(accessKey.trim() && secretKey.trim());
  }
  async call<T extends Record<string, unknown>>(action: string, payload: Record<string, unknown>): Promise<T> {
    const { accessKey, secretKey, region } = this.credentials();
    if (!accessKey.trim() || !secretKey.trim()) throw new Error('未配置方舟 Assets API 访问密钥');
    const body = JSON.stringify(payload);
    const host = `ark.${region}.volcengineapi.com`; const date = new Date(); const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); const day = stamp.slice(0, 8);
    const signedHeaders = 'content-type;host;x-content-sha256;x-date'; const payloadHash = hash(body);
    const canonical = `POST\n/\nAction=${action}&Version=2024-01-01\ncontent-type:application/json\nhost:${host}\nx-content-sha256:${payloadHash}\nx-date:${stamp}\n\n${signedHeaders}\n${payloadHash}`;
    const scope = `${day}/${region}/ark/request`; const stringToSign = `HMAC-SHA256\n${stamp}\n${scope}\n${hash(canonical)}`;
    const signingKey = hmac(hmac(hmac(hmac(secretKey, day), region), 'ark'), 'request'); const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const response = await fetch(`https://${host}/?Action=${action}&Version=2024-01-01`, { method: 'POST', headers: { 'content-type': 'application/json', host, 'x-date': stamp, 'x-content-sha256': payloadHash, authorization: `HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }, body, signal: AbortSignal.timeout(15_000) });
    const json = await response.json() as T & { Result?: T; ResponseMetadata?: { Error?: { Message?: string } } };
    if (!response.ok || json.ResponseMetadata?.Error) throw new Error(json.ResponseMetadata?.Error?.Message || `方舟 ${action} 请求失败：HTTP ${response.status}`);
    return (json.Result || json) as T;
  }
  async createValidationSession(projectName: string, callbackUrl: string) {
    const result = await this.call<{ BytedToken: string; H5Link: string }>('CreateVisualValidateSession', { ProjectName: projectName, CallbackURL: callbackUrl });
    if (!result.BytedToken || !/^https:\/\//.test(result.H5Link)) throw new Error('方舟未返回有效的真人认证链接');
    return result;
  }
  async validationResult(projectName: string, bytedToken: string) {
    return this.call<{ GroupId?: string }>('GetVisualValidateResult', { ProjectName: projectName, BytedToken: bytedToken });
  }
  async createImage(projectName: string, groupId: string, url: string, name: string) {
    const result = await this.call<{ Id?: string }>('CreateAsset', { ProjectName: projectName, GroupId: groupId, URL: url, AssetType: 'Image', Name: name });
    if (!result.Id || !/^asset-[a-z0-9-]+$/i.test(result.Id)) throw new Error('方舟未返回有效的图片资产 ID');
    return result.Id;
  }
  async getAsset(projectName: string, assetId: string): Promise<ArkAsset & { GroupId?: string }> {
    return this.call<ArkAsset & { GroupId?: string }>('GetAsset', { ProjectName: projectName, Id: assetId });
  }
  async findImageByName(projectName: string, groupId: string, name: string) {
    const result = await this.call<{ Items?: ArkAsset[] }>('ListAssets', { ProjectName: projectName,
      Filter: { GroupType: 'LivenessFace', GroupIds: [groupId], Name: name }, MaxResults: 100, SortBy: 'CreateTime', SortOrder: 'Desc' });
    return result.Items?.find(item => item.Name === name && item.GroupId === groupId && item.AssetType === 'Image');
  }
  async findImage(projectName: string, groupId: string, assetId?: string) {
    if (assetId) {
      const asset = await this.getAsset(projectName, assetId);
      return asset.AssetType === 'Image' && asset.GroupId === groupId ? asset : undefined;
    }
    const result = await this.call<{ Items?: ArkAsset[] }>('ListAssets', { ProjectName: projectName,
      Filter: { GroupType: 'LivenessFace', GroupIds: [groupId] }, MaxResults: 100, SortBy: 'UpdateTime', SortOrder: 'Desc' });
    return result.Items?.find(item => item.AssetType === 'Image' && item.GroupId === groupId);
  }
}
