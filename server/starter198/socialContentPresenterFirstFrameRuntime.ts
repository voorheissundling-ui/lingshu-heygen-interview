import type { DataStore } from '../storage/datastore.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import { validatePresenterRightsEvidence } from '../lib/presenterAssetTrust.js';
import type { SocialContentAutoProductionRuntime } from './socialContentProductionExecution.js';
import {createPresenterFirstFrameApproval,listPresenterFirstFrameApprovalsForReview,type PresenterFirstFrameApprovalContract} from './socialContentPresenterFirstFrameApproval.js';
import {SeedreamFirstFrameGenerator} from '../lib/seedreamFirstFrameGenerator.js';
import {firstFrameInputFingerprint,type FirstFrameReference,type FirstFrameRequest} from '../lib/firstFrameGenerator.js';
import {inspectStoryboardAigcFramesWithQwen} from '../agents/qwen.js';
import {inspectStoryboardTechnicalFrames} from '../lib/storyboardAigcQuality.js';
import {evaluateStoryboardFirstFrameQuality} from '../lib/storyboardFirstFrameQualityEvaluation.js';
import {createProductionBudgetRouteReaders} from './socialContentProductionBudgetRoutes.js';
import {measureQwenRequestInputUpperBound} from './socialContentPaidRuntimePorts.js';
import {readLocalMaterials} from '../lib/materialLibrary.js';
import {readTenantMaterialBytes} from '../lib/sentenceReplicationProduction.js';
import {objectStorageDownload} from '../storage/objectStorage.js';
import {tenantAssetDir,tenantAssetRelativePath} from '../lib/assetAccess.js';
import {MEDIA_ROOT} from './socialContentAutoProduction.js';
import {inspectRenderedVisuals,runVisualFfmpeg} from '../lib/renderVisualQuality.js';
import {createPresenterFirstFrameAssetProvenance} from './socialContentPresenterFirstFrameAssetProvenance.js';

type StoredPresenter = Record<string, unknown> & { id?: string; authorized?: boolean; assetVersion?: number; avatarId?: string; voiceId?: string; imageUrl?:string; referenceMaterialIds?:string[]; rightsEvidence?: unknown; qualityInspectionAllowed?:boolean; toolMappings?: { heygen?: { avatarId?: string; voiceId?: string };runway?:{referenceMaterialIds?:string[]};sd?:{referenceMaterialIds?:string[]};seedance?:{referenceMaterialIds?:string[]} } };
export interface PresenterFirstFrameStaticResult {
  referenceCompositionHashes:string[];backgroundPlateSha256:string;
  presenterReference:{assetIds:string[];sha256s:string[]};productReferences:Array<{assetId:string;sha256:string}>;
  personRemovalEvidence:{receiptRef:string;sourceSha256:string;outputSha256:string};
  compositeFirstFrameSha256:string;compositeFirstFrameUrl:string;
  qa:{passed:boolean;receiptRef:string;reportHash:string};createdAt:string;
}
export interface PresenterFirstFrameStaticExecutor {
  /** Must invoke paidStatic.permit.beforeSubmit immediately before each real
   * supplier POST and mark its actual provider receipt afterward. */
  prepare(input:Parameters<NonNullable<SocialContentAutoProductionRuntime['preparePresenterMotherFirstFrames']>>[0] & {group:Parameters<NonNullable<SocialContentAutoProductionRuntime['preparePresenterMotherFirstFrames']>>[0]['groups'][number];presenter:StoredPresenter;frameOperationId:string;qaOperationId:string}):Promise<PresenterFirstFrameStaticResult>;
}

type ImageBytes={bytes:Buffer;mimeType:'image/jpeg'|'image/png'|'image/webp';sha256:string};
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const imageMime=(value:string):ImageBytes['mimeType']=>/png/i.test(value)?'image/png':/webp/i.test(value)?'image/webp':'image/jpeg';
const compositionHash=(value:Record<string,unknown>)=>hash(JSON.stringify(value));
function localStructuralSimilarity(expected:Buffer,actual:Buffer,width:number,height:number){
  const block=12,c1=6.5025,c2=58.5225,scores:number[]=[];
  for(let y=0;y<height;y+=block)for(let x=0;x<width;x+=block){const a:number[]=[],b:number[]=[];for(let yy=y;yy<Math.min(height,y+block);yy++)for(let xx=x;xx<Math.min(width,x+block);xx++){const i=yy*width+xx;a.push(expected[i]||0);b.push(actual[i]||0);}const ma=a.reduce((s,v)=>s+v,0)/a.length,mb=b.reduce((s,v)=>s+v,0)/b.length;let va=0,vb=0,cov=0;for(let i=0;i<a.length;i++){const da=a[i]!-ma,db=b[i]!-mb;va+=da*da;vb+=db*db;cov+=da*db;}const d=Math.max(1,a.length-1);va/=d;vb/=d;cov/=d;scores.push(((2*ma*mb+c1)*(2*cov+c2))/((ma*ma+mb*mb+c1)*(va+vb+c2)));}return scores.reduce((s,v)=>s+Math.max(-1,Math.min(1,v)),0)/Math.max(1,scores.length);
}
async function compareApprovedFrame(approvedPath:string,videoPath:string,atSeconds:number){
  const decoded=await runVisualFfmpeg([...(atSeconds?['-ss',String(atSeconds)]:[]),'-i',videoPath,'-map','0:v:0','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],true,{timeoutMs:30_000});
  if(!decoded.ok||!decoded.stdout.length)throw Error('presenter_mother_dynamic_qa_decode_failed');
  const width=192,height=192,[expected,actual]=await Promise.all([
    sharp(approvedPath).resize(width,height,{fit:'fill'}).grayscale().raw().toBuffer(),
    sharp(decoded.stdout).resize(width,height,{fit:'fill'}).grayscale().raw().toBuffer(),
  ]);
  let difference=0;for(let index=0;index<expected.length;index++)difference+=Math.abs((expected[index]||0)-(actual[index]||0));
  return{pixelSimilarity:Number((1-difference/Math.max(1,expected.length*255)).toFixed(6)),
    structuralSimilarity:Number(localStructuralSimilarity(expected,actual,width,height).toFixed(6))};
}

/** Keep the provider original immutable. For a pose jump confined to the
 * silent intro, freeze the approved composition for four local frames and
 * resume the provider motion before the first spoken word. */
export async function ensureStrictPresenterFirstFrames(input:{tenantId:string;runId:string;groupId:string;sourcePath:string;sourceSha256:string;approvedPath:string;approvedSha256:string}){
  const sourceBytes=await fs.readFile(input.sourcePath),approvedBytes=await fs.readFile(input.approvedPath);
  if(hash(sourceBytes)!==input.sourceSha256||hash(approvedBytes)!==input.approvedSha256)throw Error('presenter_first_frame_repair_input_changed');
  const before=await Promise.all([compareApprovedFrame(input.approvedPath,input.sourcePath,0),compareApprovedFrame(input.approvedPath,input.sourcePath,.1)]);
  const passed=(scores:typeof before)=>scores.every(score=>score.pixelSimilarity>=.9&&score.structuralSimilarity>=.8);
  if(passed(before))return{outputPath:input.sourcePath,outputSha256:input.sourceSha256,repaired:false,metrics:before};
  const key=hash(JSON.stringify({tenantId:input.tenantId,runId:input.runId,groupId:input.groupId,sourceSha256:input.sourceSha256,approvedSha256:input.approvedSha256,policy:'approved-four-frame-intro.v1'}));
  const root=path.resolve('data/social-content-presenter-first-frame-repairs');await fs.mkdir(root,{recursive:true,mode:0o700});
  const outputPath=path.join(root,`${key}.mp4`),receiptPath=path.join(root,`${key}.json`);
  let outputBytes:Buffer;
  try{outputBytes=await fs.readFile(outputPath);}catch{outputBytes=Buffer.alloc(0);}
  if(!outputBytes.length){
    const result=await runVisualFfmpeg(['-y','-i',input.sourcePath,'-loop','1','-i',input.approvedPath,'-filter_complex',
      '[1:v]scale=720:1280,format=yuv420p[approved];[0:v][approved]overlay=enable=lt(t\\,0.134):shortest=1:format=auto,format=yuv420p[v]',
      '-map','[v]','-map','0:a?','-c:v','libx264','-crf','18','-preset','veryfast','-c:a','copy','-movflags','+faststart','-shortest',outputPath],false,{timeoutMs:120_000});
    if(!result.ok)throw Error('presenter_first_frame_local_repair_failed');
    outputBytes=await fs.readFile(outputPath);
  }
  const after=await Promise.all([compareApprovedFrame(input.approvedPath,outputPath,0),compareApprovedFrame(input.approvedPath,outputPath,.1)]);
  if(!passed(after))throw Error('presenter_first_frame_local_repair_qa_failed');
  const outputSha256=hash(outputBytes);
  const evidence={schemaVersion:'presenter-approved-intro-repair.v1',tenantId:input.tenantId,runId:input.runId,groupId:input.groupId,
    sourceSha256:input.sourceSha256,approvedSha256:input.approvedSha256,outputSha256,before,after,policy:'approved-four-frame-intro.v1'};
  await fs.writeFile(receiptPath,JSON.stringify({...evidence,recordHash:hash(JSON.stringify(evidence))},null,2),{mode:0o600});
  return{outputPath,outputSha256,repaired:true,metrics:after};
}
function intent(input:Parameters<PresenterFirstFrameStaticExecutor['prepare']>[0],operationId:string){
  const matches=input.paidStatic.intents.filter(item=>item.operationId===operationId);if(matches.length!==1)throw Error('presenter_first_frame_paid_intent_missing');return matches[0]!;
}
async function validImage(bytes:Buffer,mimeType:string):Promise<ImageBytes>{
  const metadata=await sharp(bytes,{failOn:'error'}).metadata();if(!metadata.width||!metadata.height||metadata.width<64||metadata.height<64)throw Error('presenter_first_frame_image_invalid');
  return{bytes,mimeType:imageMime(mimeType),sha256:hash(bytes)};
}
async function loadReferenceFrame(store:DataStore,tenantId:string,url:string):Promise<ImageBytes>{
  const parsed=url.match(/^\/api\/overseas\/videos\/([^/]+)\/shot\/(\d+)\/first-frame$/);
  if(!parsed)throw Error('presenter_first_frame_reference_url_unsupported');
  const record=await store.getById<Record<string,unknown>>('trend_videos',decodeURIComponent(parsed[1]!));
  if(!record||String(record.tenantId||'')!==tenantId)throw Error('presenter_first_frame_reference_not_owned');
  const raw=record.geminiAnalysis||record.aiAnalysis||record.analysis||record.gemini;
  let analysis:Record<string,unknown>={};try{analysis=typeof raw==='string'?JSON.parse(raw):raw&&typeof raw==='object'?raw as Record<string,unknown>:{};}catch{}
  const gemini=analysis.gemini&&typeof analysis.gemini==='object'?analysis.gemini as Record<string,unknown>:analysis;
  const details=Array.isArray(gemini.scriptDetails15s)?gemini.scriptDetails15s:[];
  const evidence=(details[Number(parsed[2])-1] as Record<string,unknown>|undefined)?.materialEvidence as Record<string,unknown>|undefined;
  const objectKey=String(evidence?.firstFrameObjectKey||'');
  if(objectKey){const object=await objectStorageDownload(objectKey);if(object?.buf.length)return validImage(object.buf,object.contentType);}
  const file=path.join(tenantAssetDir(MEDIA_ROOT,tenantId),'trend-shots',String(record.id||parsed[1]),`shot-${Number(parsed[2])}.jpg`);
  return validImage(await fs.readFile(file),'image/jpeg');
}
async function loadPresenterMaster(tenantId:string,presenter:StoredPresenter):Promise<ImageBytes>{
  const ids=[...(presenter.referenceMaterialIds||[]),...(presenter.toolMappings?.seedance?.referenceMaterialIds||[]),...(presenter.toolMappings?.sd?.referenceMaterialIds||[]),...(presenter.toolMappings?.runway?.referenceMaterialIds||[])];
  const material=readLocalMaterials().find(item=>ids.includes(String(item.id))&&item.type==='image'&&(item.scope==='shared'||String(item.tenantId||item.tenant_id||'')===tenantId));
  if(material){const loaded=await readTenantMaterialBytes(material,tenantId);return validImage(loaded.bytes,loaded.mimeType);}
  const url=String(presenter.imageUrl||'');
  if(url.startsWith('/media/')){const relative=decodeURIComponent(url.slice('/media/'.length));const file=path.resolve(MEDIA_ROOT,relative),root=path.resolve(tenantAssetDir(MEDIA_ROOT,tenantId));if(!file.startsWith(root+path.sep))throw Error('presenter_first_frame_master_not_owned');return validImage(await fs.readFile(file),path.extname(file));}
  if(/^https:\/\//.test(url)){const parsed=new URL(url);if(!/(^|\.)heygen\.(com|ai)$/.test(parsed.hostname))throw Error('presenter_first_frame_master_host_untrusted');const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30_000)});if(!response.ok||Number(response.headers.get('content-length')||0)>15*1024*1024)throw Error('presenter_first_frame_master_unavailable');const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>15*1024*1024)throw Error('presenter_first_frame_master_too_large');return validImage(bytes,response.headers.get('content-type')||'');}
  throw Error('presenter_first_frame_master_missing');
}
async function loadProductReferences(tenantId:string,ids:string[]):Promise<Array<ImageBytes&{assetId:string}>>{
 const materials=readLocalMaterials(),loaded:Array<ImageBytes&{assetId:string}>=[];
 for(const assetId of [...new Set(ids)]){
  const matches=materials.filter(item=>String(item.id)===assetId&&(item.scope==='shared'||String(item.tenantId||item.tenant_id||'')===tenantId));
  if(matches.length!==1)throw Error(`presenter_first_frame_product_asset_not_unique:${assetId}`);
  const value=await readTenantMaterialBytes(matches[0]!,tenantId),image=await validImage(value.bytes,value.mimeType);loaded.push({...image,assetId});
 }
 return loaded;
}

/** Re-resolve the immutable manifest inputs from their current authoritative
 * stores before an old approval is reused. Same-id byte replacement must not
 * survive until post-generation QA to be discovered. */
export async function currentPresenterFirstFrameAssetProvenanceHash(store:DataStore,input:{tenantId:string;approval:PresenterFirstFrameApprovalContract},options:{loadReferenceFrame?:(tenantId:string,url:string)=>Promise<ImageBytes>;loadPresenterMaster?:(tenantId:string,presenter:StoredPresenter)=>Promise<ImageBytes>;loadProductReferences?:(tenantId:string,ids:string[])=>Promise<Array<ImageBytes&{assetId:string}>>}={}){
 const approved=input.approval.assetProvenance;
 if(!approved)return null;
 const defaults=await store.list<{payload?:{presenters?:StoredPresenter[]}}>('studio_production_defaults',{where:{tenant_id:input.tenantId},perPage:2});
 if(defaults.totalItems!==1||defaults.items.length!==1)throw Error('presenter_first_frame_current_presenter_store_not_unique');
 const matches=(defaults.items[0]!.payload?.presenters||[]).filter(item=>String(item.id||'')===approved.presenter.assetId);
 if(matches.length!==1)throw Error('presenter_first_frame_current_presenter_not_unique');
 const presenter=matches[0]!,version=Number(presenter.assetVersion);
 if(version!==approved.presenter.assetVersion)throw Error('presenter_first_frame_current_presenter_version_changed');
 const person=await (options.loadPresenterMaster||loadPresenterMaster)(input.tenantId,presenter);
 const products=[] as typeof approved.products;
 for(const product of approved.products){
  const refs=await (options.loadProductReferences||loadProductReferences)(input.tenantId,product.referenceImageIds);
  products.push({...product,referenceImageSha256s:refs.map(item=>item.sha256)});
 }
 const background=await (options.loadReferenceFrame||((tenantId,url)=>loadReferenceFrame(store,tenantId,url)))(input.tenantId,approved.background.referenceFirstFrameRef);
 return createPresenterFirstFrameAssetProvenance({
  presenter:{...approved.presenter,referenceSha256s:[person.sha256]},products,
  background:{...approved.background,referenceFirstFrameSha256:background.sha256},
 }).manifestHash;
}

/** Real static supplier bridge. It creates one combined person-removal +
 * authorised-person composite, then independently pays Qwen to review the
 * source, identity reference and generated candidate. */
export function createPresenterFirstFrameStaticExecutor(store:DataStore,options:{root?:string;generator?:SeedreamFirstFrameGenerator;inspect?:typeof inspectStoryboardAigcFramesWithQwen;now?:()=>Date;assertProviderBinding?:(route:{stage:string;provider:string;model:string;accountRef:string})=>Promise<void>;loadReferenceFrame?:(tenantId:string,url:string)=>Promise<ImageBytes>;loadPresenterMaster?:(tenantId:string,presenter:StoredPresenter)=>Promise<ImageBytes>;loadProductReferences?:(tenantId:string,ids:string[])=>Promise<Array<ImageBytes&{assetId:string}>>}={}):PresenterFirstFrameStaticExecutor{
 return{async prepare(input){
  const frameIntent=intent(input,input.frameOperationId),qaIntent=intent(input,input.qaOperationId);
  if(frameIntent.provider!=='seedream'||qaIntent.provider!=='qwen')throw Error('presenter_first_frame_provider_route_changed');
  const assertBinding=options.assertProviderBinding||createProductionBudgetRouteReaders().assertProviderBinding;await assertBinding({...frameIntent,stage:'first_frame'});await assertBinding({...qaIntent,stage:'first_frame_qa'});
  const selected=input.group.compositions[0]!,source=await (options.loadReferenceFrame||((tenantId,url)=>loadReferenceFrame(store,tenantId,url)))(input.scope.tenantId,selected.referenceFirstFrameUrl),person=await (options.loadPresenterMaster||loadPresenterMaster)(input.scope.tenantId,input.presenter),products=await (options.loadProductReferences||loadProductReferences)(input.scope.tenantId,input.group.productAssetBinding?.referenceImageIds??[]);
  const references:FirstFrameReference[]=[{role:'source_composition',...source},{role:'authorized_presenter',...person},...products.map(product=>({role:'product_identity' as const,bytes:product.bytes,mimeType:product.mimeType,sha256:product.sha256}))];
  const generator=options.generator||new SeedreamFirstFrameGenerator({model:frameIntent.model});
  const request:FirstFrameRequest={referenceMode:'presenter_replace',tenantId:input.scope.tenantId,videoId:input.scope.taskId,compositionId:input.group.groupId,presenterVersion:`${input.group.presenterAssetId}:${Number(input.presenter.assetVersion)}`,ratio:'9:16',prompt:`严格保持图一的背景、机位、景别、构图、光线和物体位置。移除图一原人物，只把图二已授权人物自然合成到原人物位置；保持图二人物身份、脸型与五官。${products.length?'人物接触或展示的产品必须严格采用后续企业产品参考图的包装、颜色、标识与比例，不得替换产品。':'不得新增产品或道具。'}不得改变背景，不得新增文字、Logo或水印。参考背景：${selected.background}；景别：${selected.framing}；机位：${selected.camera}；构图：${selected.composition}。`,references,idempotencyKey:''};
  request.idempotencyKey=firstFrameInputFingerprint(request,'seedream',frameIntent.model);
  let frameBoundary=false;const paidGenerator=options.generator||new SeedreamFirstFrameGenerator({model:frameIntent.model,beforeSubmit:async body=>{frameBoundary=true;const {maximumUnits,...binding}=frameIntent;await input.paidStatic.permit.beforeSubmit({...binding,actualUnits:{inputImages:Array.isArray(body.image)?body.image.length:0,outputImages:1}});}});
  if(options.generator){const {maximumUnits,...binding}=frameIntent;await input.paidStatic.permit.beforeSubmit({...binding,actualUnits:{inputImages:references.length,outputImages:1}});frameBoundary=true;}
  const generated=await paidGenerator.generate(request);if(!frameBoundary)throw Error('presenter_first_frame_paid_boundary_missing');
  const frameReceipt=`seedream:${generated.providerRequestId}:${hash(generated.bytes)}`;await input.paidStatic.permit.markOutcome(input.frameOperationId,'completed',frameReceipt);
  const out=await validImage(generated.bytes,generated.mimeType),label='候选首帧';let providerReceipt:unknown=null,qaBoundary=false;
  const inspect=options.inspect||inspectStoryboardAigcFramesWithQwen;
  const evaluation=input.presenter.qualityInspectionAllowed===false
   ? null
   : await evaluateStoryboardFirstFrameQuality({sceneType:'general',hasProduct:products.length>0,hasNamedPerson:true,hasEnvironmentReference:true,hasContact:products.length>0,hasAction:products.length>0,candidateLabels:[label],referenceLabels:['原分镜背景与构图','已授权人物参考图',...products.map(item=>`企业产品图:${item.assetId}`)],applyReplicationAutomation:false,
    inspectTechnical:()=>inspectStoryboardTechnicalFrames('first_frame',[{bytes:out.bytes,timeLabel:label}]),inspectVisual:()=>inspect({model:qaIntent.model,boundedPaidQa:true,paidSubmission:async body=>{const {maximumUnits,...binding}=qaIntent;qaBoundary=true;await input.paidStatic.permit.beforeSubmit({...binding,actualUnits:{inputTokens:await measureQwenRequestInputUpperBound(body),outputTokens:Number(body.max_tokens)}});},onReceipt:value=>{providerReceipt=value;},phase:'first_frame',sceneType:'general',frames:[{base64:out.bytes.toString('base64'),mimeType:out.mimeType,timeLabel:label}],personReferences:[{base64:person.bytes.toString('base64'),mimeType:person.mimeType,timeLabel:'已授权人物参考图'}],productReferences:products.map(item=>({base64:item.bytes.toString('base64'),mimeType:item.mimeType,timeLabel:`企业产品图:${item.assetId}`})),environmentReferences:[{base64:source.bytes.toString('base64'),mimeType:source.mimeType,timeLabel:'原分镜背景与构图'}],storyboard:request.prompt,productInfo:products.length?`产品身份必须与企业产品图一致；${input.group.productAssetBinding?.productId}`:'无产品身份要求；人物身份以已授权人物参考图为准，背景、机位和构图以原分镜为准。'})});
  let qaPassed=false,qaReceipt='',reportHash='';
  if(evaluation){
    if(!qaBoundary||!providerReceipt)throw Error('presenter_first_frame_qa_receipt_missing');
    const report=evaluation.firstFrameQuality;reportHash=hash(JSON.stringify({evaluation,providerReceipt}));const qwenId=String((providerReceipt as Record<string,unknown>).id||'').trim();if(!qwenId)throw Error('presenter_first_frame_qwen_request_id_missing');
    qaReceipt=`qwen:${qwenId}:${reportHash}`;await input.paidStatic.permit.markOutcome(input.qaOperationId,'completed',qaReceipt);qaPassed=Boolean(evaluation.firstFrameQualityState==='evaluated'&&report?.automatedPassed);
  }else{
    const technical=await inspectStoryboardTechnicalFrames('first_frame',[{bytes:out.bytes,timeLabel:label}]);qaPassed=!technical.some(item=>item.verdict==='fail');reportHash=hash(JSON.stringify({mode:'local_technical_plus_user_confirmation',technical}));qaReceipt=`local-technical:${reportHash}`;
  }
  const relative=tenantAssetRelativePath(input.scope.tenantId,`presenter-first-frames/${input.scope.runId}-${input.group.groupId}-${out.sha256.slice(0,16)}.${out.mimeType==='image/png'?'png':out.mimeType==='image/webp'?'webp':'jpg'}`),file=path.join(options.root||MEDIA_ROOT,relative);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,out.bytes,{mode:0o600});await fs.writeFile(`${file}.qa.json`,JSON.stringify({evaluation,providerReceipt},null,2),{mode:0o600});
  return{referenceCompositionHashes:input.group.compositions.map(value=>compositionHash(value)),backgroundPlateSha256:source.sha256,presenterReference:{assetIds:[String(input.group.presenterAssetId)],sha256s:[person.sha256]},productReferences:products.map(product=>({assetId:product.assetId,sha256:product.sha256})),personRemovalEvidence:{receiptRef:frameReceipt,sourceSha256:source.sha256,outputSha256:out.sha256},compositeFirstFrameSha256:out.sha256,compositeFirstFrameUrl:`/media/${relative}`,qa:{passed:qaPassed,receiptRef:qaReceipt,reportHash},createdAt:(options.now?.()||new Date()).toISOString()};
 }};
}

/** Validate the durable production inputs at the real worker boundary. The
 * repository currently lacks a ledger-authorized person-removal/composite
 * operation for this preflight hook. Calling an image model here would happen
 * before the task budget is frozen, so the adapter fails at that exact gap. */
export function createPresenterFirstFrameProductionRuntime(store: DataStore, executor?:PresenterFirstFrameStaticExecutor): Pick<SocialContentAutoProductionRuntime, 'preparePresenterMotherFirstFrames'|'evaluatePresenterMotherDynamicQa'> {
  return {
  async evaluatePresenterMotherDynamicQa(input) {
    const approvals=await listPresenterFirstFrameApprovalsForReview(store,{tenantId:input.tenantId,taskId:input.taskId,runId:input.runId});
    const approval=approvals.find(item=>item.groupId===input.segmentId&&item.presenter.assetId===input.presenterAssetId);
    if(!approval)throw Error(`presenter_mother_dynamic_qa_approval_missing:${input.segmentId}`);
    const expectedPath=path.resolve(MEDIA_ROOT,decodeURIComponent(approval.compositeFirstFrameUrl.replace(/^\/media\//,'')));
    const tenantRoot=path.resolve(tenantAssetDir(MEDIA_ROOT,input.tenantId));
    if(!expectedPath.startsWith(tenantRoot+path.sep))throw Error('presenter_mother_dynamic_qa_reference_not_owned');
    const actualBytes=await fs.readFile(input.outputPath);
    if(hash(actualBytes)!==input.outputSha256)throw Error('presenter_mother_dynamic_qa_output_hash_changed');
    const earlyFrames=await Promise.all([compareApprovedFrame(expectedPath,input.outputPath,0),compareApprovedFrame(expectedPath,input.outputPath,.1)]);
    const pixelSimilarity=Math.min(...earlyFrames.map(frame=>frame.pixelSimilarity));
    const structuralSimilarity=Math.min(...earlyFrames.map(frame=>frame.structuralSimilarity));
    const pixelThreshold=.9,structuralThreshold=.8;
    const technical=await inspectRenderedVisuals({outputPath:input.outputPath,expectedDuration:4});
    const report={schemaVersion:'presenter-dynamic-local-continuity.v4',segmentId:input.segmentId,segmentHash:input.segmentHash,outputSha256:input.outputSha256,approvedFirstFrameSha256:approval.compositeFirstFrameSha256,earlyFrames,pixelSimilarity,pixelThreshold,structuralSimilarity,structuralThreshold,technical,
      audioTrackStatus:'unverified',lipSyncStatus:'unverified'};
    const reportHash=hash(JSON.stringify(report));
    const reportRoot=path.resolve('data/social-content-presenter-dynamic-qa');await fs.mkdir(reportRoot,{recursive:true,mode:0o700});
    await fs.writeFile(path.join(reportRoot,`${reportHash}.json`),JSON.stringify({...report,reportHash},null,2),{mode:0o600});
    if(!technical.passed||pixelSimilarity<pixelThreshold||structuralSimilarity<structuralThreshold)throw Error(`presenter_mother_dynamic_qa_failed:${input.segmentId}`);
    // This is only visual continuity evidence. The producer must combine it
    // with independent frozen-audio matching and official SyncNet evidence;
    // this skipped status alone is never an acceptance receipt.
    return{identitySimilarity:Math.min(1,pixelSimilarity/pixelThreshold,structuralSimilarity/structuralThreshold),identityThreshold:1,
      lipSyncStatus:'skipped_unconfigured' as const,receiptRef:`local-presenter-continuity:${reportHash}`,reportHash};
  },
  async preparePresenterMotherFirstFrames(input) {
    if (!input.groups.length) return [];
    if (new Set(input.groups.map(group => group.groupId)).size !== input.groups.length) throw new Error('presenter_first_frame_group_scope_ambiguous');
    const defaults = await store.list<{payload?: {defaultPresenterId?: string; presenters?: StoredPresenter[]}}>('studio_production_defaults', { where: { tenant_id: input.scope.tenantId }, perPage: 2 });
    if (defaults.totalItems !== 1 || defaults.items.length !== 1) throw new Error('presenter_first_frame_default_presenter_store_not_unique');
    const payload = defaults.items[0]!.payload || {}, defaultPresenterId = String(payload.defaultPresenterId || '').trim();
    if (!defaultPresenterId&&input.groups.some(group=>group.executionKind!=='seedance_motion')) throw new Error('presenter_first_frame_default_presenter_missing');
    const presenters=new Map<string,StoredPresenter>();
    for (const group of input.groups) {
      // The approved task freezes the exact presenter asset. A later change to
      // the account default must not rewrite or strand that in-flight task; the
      // locked asset still has to exist and pass the full rights/version checks
      // below before any supplier request is allowed.
      if (!group.compositions.length || group.compositions.some(value => !value.referenceShotId.trim() || !value.referenceFirstFrameUrl.trim() || !value.background.trim() || !value.framing.trim() || !value.camera.trim() || !value.composition.trim())) throw new Error(`presenter_first_frame_reference_composition_incomplete:${group.groupId}`);
      const matches = (payload.presenters || []).filter(item => String(item.id || '').trim() === group.presenterAssetId);
      if (matches.length !== 1) throw new Error(`presenter_first_frame_presenter_asset_not_unique:${group.groupId}`);
      const presenter = matches[0]!, version = Number(presenter.assetVersion);
      const avatarId = String(presenter.toolMappings?.heygen?.avatarId || presenter.avatarId || '').trim(), voiceId = String(presenter.toolMappings?.heygen?.voiceId || presenter.voiceId || '').trim();
      const rights = validatePresenterRightsEvidence(presenter.rightsEvidence, { provider: 'heygen', uses: ['digital_presenter', 'voice_synthesis'] });
      const arkRights=validatePresenterRightsEvidence(presenter.rightsEvidence,{provider:'volcengine_ark',uses:['person_replacement']});
      const qwenRights=validatePresenterRightsEvidence(presenter.rightsEvidence,{provider:'dashscope',uses:['quality_inspection']});
      const motionOnly=group.executionKind==='seedance_motion';
      const motionRights=validatePresenterRightsEvidence(presenter.rightsEvidence,{provider:'volcengine_ark',uses:['digital_presenter','person_replacement']});
      if (presenter.authorized !== true || !Number.isSafeInteger(version) || version < 1 || (!motionOnly&&(!avatarId || !voiceId || !rights.ok)) || !arkRights.ok || (motionOnly&&!motionRights.ok)) throw new Error(`presenter_first_frame_default_presenter_not_authorized:${group.groupId}`);
      presenter.qualityInspectionAllowed=qwenRights.ok;
      presenters.set(group.groupId,presenter);
    }
    if(!executor)throw new Error('presenter_first_frame_paid_static_executor_missing');
    const approvals:PresenterFirstFrameApprovalContract[]=[];
    const existing=new Map((await listPresenterFirstFrameApprovalsForReview(store,{tenantId:input.scope.tenantId,taskId:input.scope.taskId,runId:input.scope.runId})).map(item=>[item.groupId,item]));
    for(const group of input.groups){
      const prior=existing.get(group.groupId);
      if(prior){
        if(prior.planHash!==input.scope.planHash||prior.presenterGroupContractHash!==group.presenterGroupContractHash||prior.presenter.assetId!==group.presenterAssetId)throw Error(`presenter_first_frame_contract_conflict:${group.groupId}`);
        approvals.push(prior);continue;
      }
      const requirements=input.paidStatic.requirements.filter(r=>r.presenterGroupId===group.groupId&&['first_frame','first_frame_qa'].includes(r.stage));
      if(requirements.length!==2)throw Error(`presenter_first_frame_paid_requirements_missing:${group.groupId}`);
      // Route is part of the planner's operation hash, therefore bind by the
      // unique stage/group pair here and leave the permit to verify every
      // provider/model/account/input hash at submission time.
      const frame=input.paidStatic.intents.filter(i=>i.stage==='first_frame'&&i.shotId===group.groupId),qa=input.paidStatic.intents.filter(i=>i.stage==='first_frame_qa'&&i.shotId===group.groupId);
      if(frame.length!==1||qa.length!==1)throw Error(`presenter_first_frame_paid_intents_ambiguous:${group.groupId}`);
      const result=await executor.prepare({...input,group,presenter:presenters.get(group.groupId)!,frameOperationId:frame[0]!.operationId,qaOperationId:qa[0]!.operationId});
      const frameReceipt=await input.paidStatic.permit.assertRecovery(frame[0]!.operationId);
      const qaReceipt=presenters.get(group.groupId)!.qualityInspectionAllowed===false?null:await input.paidStatic.permit.assertRecovery(qa[0]!.operationId);
      if(frameReceipt.status!=='completed'||frameReceipt.receiptRef!==result.personRemovalEvidence.receiptRef||
        (qaReceipt&&(qaReceipt.status!=='completed'||qaReceipt.receiptRef!==result.qa.receiptRef)))throw Error(`presenter_first_frame_paid_receipt_unverified:${group.groupId}`);
      if(!result.qa.passed)throw Error(`presenter_first_frame_qa_failed:${group.groupId}`);
      const rights=presenters.get(group.groupId)!.rightsEvidence as {authorizationRef?:string;consentRef?:string};
      const motionOnly=group.executionKind==='seedance_motion';
      const selected=group.compositions[0]!;
      if(group.productAssetBinding&&(result.productReferences.length!==group.productAssetBinding.referenceImageIds.length||result.productReferences.some((item,index)=>item.assetId!==group.productAssetBinding!.referenceImageIds[index])))throw Error(`presenter_first_frame_product_evidence_changed:${group.groupId}`);
      const assetProvenance=createPresenterFirstFrameAssetProvenance({presenter:{assetId:group.presenterAssetId,assetVersion:Number(presenters.get(group.groupId)!.assetVersion),referenceAssetIds:result.presenterReference.assetIds,referenceSha256s:result.presenterReference.sha256s},products:group.productAssetBinding?[{...group.productAssetBinding,referenceImageSha256s:result.productReferences.map(item=>item.sha256)}]:[],background:{referenceSourceId:selected.referenceSourceId,referenceShotId:selected.referenceShotId,startSeconds:selected.startSeconds,endSeconds:selected.endSeconds,referenceFirstFrameRef:selected.referenceFirstFrameUrl,referenceFirstFrameSha256:result.backgroundPlateSha256}});
      approvals.push(await createPresenterFirstFrameApproval(store,{...input.scope,groupId:group.groupId,presenterGroupContractHash:group.presenterGroupContractHash,referenceCompositionHashes:result.referenceCompositionHashes,backgroundPlateSha256:result.backgroundPlateSha256,personRemovalEvidence:result.personRemovalEvidence,...(group.productAssetBinding?{productAssetBinding:{productId:group.productAssetBinding.productId,enterpriseFactRef:group.productAssetBinding.enterpriseFactRef,referenceAssetIds:group.productAssetBinding.referenceImageIds}}:{}),assetProvenance,presenter:{assetId:group.presenterAssetId,assetVersion:Number(presenters.get(group.groupId)!.assetVersion),authorizationRef:String(rights.authorizationRef||''),consentRef:String(rights.consentRef||''),providerId:motionOnly?'seedance':'heygen',...(motionOnly?{identityMode:'enterprise_asset_first_frame' as const}:{}),providerPresenterId:motionOnly?null:String(presenters.get(group.groupId)!.toolMappings?.heygen?.avatarId||presenters.get(group.groupId)!.avatarId||''),providerVoiceId:motionOnly?null:String(presenters.get(group.groupId)!.toolMappings?.heygen?.voiceId||presenters.get(group.groupId)!.voiceId||'')},compositeFirstFrameSha256:result.compositeFirstFrameSha256,compositeFirstFrameUrl:result.compositeFirstFrameUrl,qa:result.qa,createdAt:result.createdAt}));
    }
    return approvals;
  } };
}
