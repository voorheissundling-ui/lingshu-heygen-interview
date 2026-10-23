import {getToken} from './auth';
/** Stable navigation fingerprint, never an authentication credential or authorization proof. */
export function productionNavigationIdentity():string{
 let token='';try{token=getToken()||'';}catch{/* no browser storage */}
 let first=2166136261,second=2246822507;
 for(let index=0;index<token.length;index++){const code=token.charCodeAt(index);first=Math.imul(first^code,16777619);second=Math.imul(second^code,3266489909);}
 return `navigation:${token?'signed-in':'signed-out'}:${(first>>>0).toString(16)}:${(second>>>0).toString(16)}`;
}
export function stampProductionHistoryState(state:Record<string,unknown>){return {...state,productionAuthAuthority:productionNavigationIdentity()};}
export function canRestoreProductionHistoryState(state:unknown):boolean{return !!state&&typeof state==='object'&&(state as Record<string,unknown>).productionAuthAuthority===productionNavigationIdentity();}
/** Customer conversation handoffs are one-shot, revalidated reads, never history replay. */
export function restorableProductionDetail(state:unknown):Record<string,unknown>|null{
 if(!canRestoreProductionHistoryState(state))return null;
 const detail=(state as Record<string,unknown>).productionDetail;
 if(!detail||typeof detail!=='object')return null;
 const ref=(detail as Record<string,unknown>).businessRef as Record<string,unknown>|undefined;
 if(ref?.customerNavigation||ref?.followupItemId)return null;
 return detail as Record<string,unknown>;
}
/** Same-tab history for the production drill-down. No task execution occurs here. */
export function requestProductionBack() {window.dispatchEvent(new CustomEvent('lingshu:back'));}
export function pushProductionLocation(page: string, extra: Record<string, unknown> = {}) {
 const url = new URL(window.location.href);url.searchParams.set('page', page);
 window.history.pushState(stampProductionHistoryState({...extra,productionPage:page,productionDepth:(window.history.state?.productionDepth||0)+1}), '', url);
}
