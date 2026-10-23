import {createHash} from 'node:crypto';

const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):value;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const text=(value:unknown)=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=2000;
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export interface PresenterFirstFrameAssetProvenance {
  schemaVersion:'presenter-first-frame-asset-provenance.v1';
  presenter:{assetId:string;assetVersion:number;referenceAssetIds:string[];referenceSha256s:string[]};
  products:Array<{productId:string;enterpriseFactRef:string;enterpriseFactVersion:string;referenceImageIds:string[];referenceImageSha256s:string[]}>;
  background:{referenceSourceId:string;referenceShotId:string;startSeconds:number;endSeconds:number;referenceFirstFrameRef:string;referenceFirstFrameSha256:string};
  manifestHash:string;
}

type ProvenanceInput=Omit<PresenterFirstFrameAssetProvenance,'schemaVersion'|'manifestHash'>;

function sortedPairs(ids:string[],hashes:string[]){
  if(ids.length!==hashes.length)throw Error('presenter_first_frame_asset_provenance_reference_pair_invalid');
  const pairs=ids.map((id,index)=>({id,sha256:hashes[index]!})).sort((a,b)=>a.id.localeCompare(b.id));
  if(new Set(pairs.map(pair=>pair.id)).size!==pairs.length)throw Error('presenter_first_frame_asset_provenance_reference_pair_invalid');
  return{ids:pairs.map(pair=>pair.id),hashes:pairs.map(pair=>pair.sha256)};
}

export function presenterFirstFrameAssetProvenanceHash(input:Omit<PresenterFirstFrameAssetProvenance,'manifestHash'>|PresenterFirstFrameAssetProvenance){
  const {manifestHash:_,...body}=input as PresenterFirstFrameAssetProvenance;
  return hash(body);
}

export function createPresenterFirstFrameAssetProvenance(input:ProvenanceInput):PresenterFirstFrameAssetProvenance{
  const presenterRefs=sortedPairs(input.presenter.referenceAssetIds,input.presenter.referenceSha256s);
  const body={schemaVersion:'presenter-first-frame-asset-provenance.v1' as const,presenter:{...input.presenter,referenceAssetIds:presenterRefs.ids,referenceSha256s:presenterRefs.hashes},products:[...input.products].map(product=>{const refs=sortedPairs(product.referenceImageIds,product.referenceImageSha256s);return{...product,referenceImageIds:refs.ids,referenceImageSha256s:refs.hashes};}).sort((a,b)=>a.productId.localeCompare(b.productId)),background:{...input.background}};
  const manifest={...body,manifestHash:presenterFirstFrameAssetProvenanceHash(body)};
  if(!isPresenterFirstFrameAssetProvenance(manifest))throw Error('presenter_first_frame_asset_provenance_invalid');
  return manifest;
}

export function isPresenterFirstFrameAssetProvenance(value:unknown):value is PresenterFirstFrameAssetProvenance{
  if(!value||typeof value!=='object')return false;
  const item=value as PresenterFirstFrameAssetProvenance,presenter=item.presenter,background=item.background;
  if(item.schemaVersion!=='presenter-first-frame-asset-provenance.v1'||!presenter||!background||!sha(item.manifestHash)
    ||!text(presenter.assetId)||!Number.isSafeInteger(presenter.assetVersion)||presenter.assetVersion<1
    ||!Array.isArray(presenter.referenceAssetIds)||!presenter.referenceAssetIds.length||!presenter.referenceAssetIds.every(text)
    ||new Set(presenter.referenceAssetIds).size!==presenter.referenceAssetIds.length
    ||!Array.isArray(presenter.referenceSha256s)||presenter.referenceSha256s.length!==presenter.referenceAssetIds.length||!presenter.referenceSha256s.every(sha)
    ||!text(background.referenceSourceId)||!text(background.referenceShotId)||!text(background.referenceFirstFrameRef)||!sha(background.referenceFirstFrameSha256)
    ||!Number.isFinite(background.startSeconds)||!Number.isFinite(background.endSeconds)||background.startSeconds<0||background.endSeconds<=background.startSeconds
    ||!Array.isArray(item.products))return false;
  for(const product of item.products){
    if(!text(product.productId)||!text(product.enterpriseFactRef)||!text(product.enterpriseFactVersion)
      ||!Array.isArray(product.referenceImageIds)||!product.referenceImageIds.length||!product.referenceImageIds.every(text)
      ||new Set(product.referenceImageIds).size!==product.referenceImageIds.length
      ||!Array.isArray(product.referenceImageSha256s)||product.referenceImageSha256s.length!==product.referenceImageIds.length||!product.referenceImageSha256s.every(sha))return false;
  }
  return item.manifestHash===presenterFirstFrameAssetProvenanceHash(item);
}

/** Approval consumers compare the current resolved inputs with the frozen
 * manifest. Any person, SKU/fact/image or benchmark-background drift fails
 * closed before a previously approved first frame can be reused. */
export function assertPresenterFirstFrameAssetProvenance(current:ProvenanceInput,approved:PresenterFirstFrameAssetProvenance){
  const resolved=createPresenterFirstFrameAssetProvenance(current);
  if(!isPresenterFirstFrameAssetProvenance(approved)||resolved.manifestHash!==approved.manifestHash)throw Error('presenter_first_frame_asset_provenance_changed');
  return approved;
}
