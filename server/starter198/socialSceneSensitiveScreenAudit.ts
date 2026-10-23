/** A narrow, high-confidence screen-text alarm. No match is never a privacy clearance. */
export function inspectSensitiveScreenText(rawText:string):Array<'resident_identity_number'|'private_key_marker'>{
 const text=rawText.normalize('NFKC');
 const findings=new Set<'resident_identity_number'|'private_key_marker'>();
 const compact=text.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
 if(compact.includes('BEGINPRIVATEKEY')||compact.includes('BEGINRSAPRIVATEKEY')||compact.includes('BEGINOPENSSHPRIVATEKEY'))findings.add('private_key_marker');
 const candidates=text.match(/(?<![\dA-Za-z])\d{6}[\s-]?(?:19|20)\d{2}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{3}[\dXx](?![\dA-Za-z])/g)??[];
 const weights=[7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
 const check='10X98765432';
 for(const candidate of candidates){
  const value=candidate.replace(/[\s-]/g,'').toUpperCase();
  const year=Number(value.slice(6,10)),month=Number(value.slice(10,12)),day=Number(value.slice(12,14));
  const date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)continue;
  const sum=weights.reduce((total,weight,index)=>total+Number(value[index])*weight,0);
  if(value[17]===check[sum%11])findings.add('resident_identity_number');
 }
 return [...findings].sort();
}
