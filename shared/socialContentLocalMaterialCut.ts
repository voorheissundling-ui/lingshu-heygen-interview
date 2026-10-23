import type {BenchmarkMaterialType} from './benchmarkAnalysis';
import type {SocialMaterialRouting} from './contracts/socialContentReplication';
import type {SocialShotSourceStrategy} from './contracts/socialContentWorkflow';
import type {SocialAssetInventory,SocialAssetSupplyShotRequest} from './socialContentAssetSupplyContracts';

type LocalMaterialCutRoute={strategy:SocialShotSourceStrategy;refs:string[];instruction:string;materialRouting:SocialMaterialRouting};

/** Selects a local-only cut only when the reviewed segment, semantic evidence
 * and tenant-visible inventory all name the same frozen source. */
export function selectVerifiedLocalMaterialCut(input:{
 shot:SocialAssetSupplyShotRequest; inventory:Required<SocialAssetInventory>; materialType:BenchmarkMaterialType;
}):LocalMaterialCutRoute|null{
 const {shot,inventory}=input,segment=shot.selectedMaterialSegment,match=shot.localVideoMatch;
 if(match?.semanticMatch!=='verified'||!match.evidenceRef||!segment||!match.sourceRefs.includes(segment.sourceRef)
  ||!inventory.customerVideoIds.includes(segment.sourceRef))return null;
 return{strategy:'customer_real_asset',refs:[segment.sourceRef],instruction:'仅使用已审核、已冻结片段执行本地裁切；不得调用生成供应商',
  materialRouting:{schemaVersion:'social-material-routing.v1',materialType:input.materialType,policy:'local_only',
   localMatch:{state:'matched',sourceRefs:[segment.sourceRef],evidenceRef:match.evidenceRef,productRef:match.productRef??shot.productRef??null}}};
}
