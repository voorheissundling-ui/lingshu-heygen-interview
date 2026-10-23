export interface WeeklyScanScope {tenantId:string;programId:string;packageId:string;packageVersion:number}
export function weeklyScopeMatches(scope:WeeklyScanScope|undefined,value:Partial<WeeklyScanScope>|null|undefined):boolean{
 return !scope||Boolean(value&&value.tenantId===scope.tenantId&&value.programId===scope.programId&&value.packageId===scope.packageId&&value.packageVersion===scope.packageVersion);
}
export function weeklyScopeWhere(scope?:WeeklyScanScope){return scope?{tenant_id:scope.tenantId,program_id:scope.programId,package_id:scope.packageId,package_version:scope.packageVersion}:{};}
