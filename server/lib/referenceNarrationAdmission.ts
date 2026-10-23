import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {studioPaidBudget,type StudioPaidBudget} from './studioPaidBudget.js';
export function readReferenceNarrationAdmission(budget:Pick<StudioPaidBudget,'status'>=studioPaidBudget,tenantId?:string){
 let key=process.env.DASHSCOPE_API_KEY?.trim()??'';
 if(!key){try{key=fs.readFileSync(process.env.DASHSCOPE_API_KEY_FILE||path.join(os.homedir(),'.config/lingshu/dashscope.key'),'utf8').trim();}catch{}}
 const endpoint=process.env.QWEN_ASR_BASE_URL||'https://dashscope.aliyuncs.com/api/v1';
 const providerConfigured=!!key&&['https://dashscope.aliyuncs.com/api/v1','https://dashscope-intl.aliyuncs.com/api/v1'].includes(endpoint);
 const enabled=process.env.QWEN_ASR_GENERATION_ENABLED==='true';const status=budget.status('qwen_asr',undefined,tenantId);
 return {canSubmit:enabled&&providerConfigured&&status.allowed,budgetReason:!enabled?'付费转写尚未启用':!providerConfigured?'转写服务尚未配置':status.reason,reservationCny:status.reservationCny,remainingCny:status.remainingCny};
}
