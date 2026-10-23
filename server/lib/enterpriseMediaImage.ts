import fs from 'node:fs';
import path from 'node:path';

/** Resolve knowledge-base catalog images inside the current tenant's media root. */
export function tenantCatalogImageFile(url: string, tenantId: string, mediaRoot: string): string | null {
  if (!/^[\w-]+$/.test(tenantId)) return null;
  if (!url.startsWith(`/media/tenants/${tenantId}/`) || url.includes('?') || url.includes('#')) return null;
  try {
    const route=decodeURIComponent(new URL(url,'http://local.invalid').pathname);
    const prefix=`/media/tenants/${tenantId}/`;
    if(!route.startsWith(prefix)||route.includes('\\')||! /\.(?:png|jpe?g|webp)$/i.test(route))return null;
    const root=fs.realpathSync(path.join(mediaRoot,'tenants',tenantId));
    const candidate=path.resolve(root,route.slice(prefix.length));
    const real=fs.realpathSync(candidate);
    if(!real.startsWith(`${root}${path.sep}`)||!fs.statSync(real).isFile())return null;
    if(fs.statSync(real).size>10*1024*1024)return null;
    return real;
  }catch{return null;}
}
