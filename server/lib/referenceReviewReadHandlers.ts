import type {RequestHandler} from 'express';
import type {DataStore} from '../storage/datastore.js';
import {readReferenceReviewRecord} from './referenceReviewRead.js';
import {buildSocialReferenceReviewHandoff} from '../starter198/socialReferenceReviewHandoff.js';
export function createReferenceReviewReadHandlers(input:{store:DataStore;isTestTenantId:(id:string)=>Promise<boolean>;isPublicTestTenantVideo:(record:Record<string,unknown>)=>boolean;isVisibleVideoPipelineRecord:(record:Record<string,unknown>)=>boolean;presenter:(tenantId:string)=>Promise<Parameters<typeof buildSocialReferenceReviewHandoff>[0]['presenter']>;publicVideoRecord:(record:Record<string,unknown>)=>Record<string,unknown>;mediaRoot?:string}){
 const handler=(kind:'handoff'|'video'):RequestHandler=>async(req,res,next)=>{try{
  const tenantId=res.locals.tenantId;if(typeof tenantId!=='string'||!tenantId){res.status(401).json({error:'Unauthorized'});return;}
  const record=await input.store.getById<Record<string,unknown>>('trend_videos',String(req.params.id));
  if(!record||record.tenantId!==tenantId||(await input.isTestTenantId(tenantId)&&!input.isPublicTestTenantVideo(record)&&!input.isVisibleVideoPipelineRecord(record))){res.status(404).json({error:'Not found'});return;}
  const projection=await readReferenceReviewRecord(input.store,tenantId,record,{mediaRoot:input.mediaRoot});res.setHeader('Cache-Control','private, no-store');
  res.json(kind==='handoff'?buildSocialReferenceReviewHandoff({record:projection,presenter:await input.presenter(tenantId)}):{...input.publicVideoRecord(projection),canManage:true});
 }catch(error){next(error);}};
 return {handoff:handler('handoff'),video:handler('video')};
}
