import './fsync-compat.mjs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import http from 'node:http';import https from 'node:https';import net from 'node:net';
// Only the sandbox child process is modified. Never import the user's .env.
for(const k of Object.keys(process.env))if(/TOKEN|SECRET|PASSWORD|API_KEY|ADMIN_EMAIL|DATABASE_URL|REDIS_URL|^S3_|^AWS_|^OSS_/.test(k))delete process.env[k];
process.env.NODE_ENV='test';process.env.ENABLE_LOCAL_DEV_FALLBACK='true';process.env.LOCAL_STORE_DIR=path.resolve('.interview-data/store');process.env.DATA_BACKEND='pocketbase';process.env.QUEUE_BACKEND='local';process.env.LINGSHU_LOCAL_PREVIEW='1';process.env.SOCIAL_WEEKLY_EXECUTION_WORKER_ENABLED='false';
process.env.PB_URL='http://127.0.0.1:1';
// Pin the local object backend too; never inherit another project's storage root.
process.env.OBJECT_STORAGE_DRIVER='local';process.env.LOCAL_OBJECT_STORAGE_ROOT=path.resolve('.interview-data/object-storage');
const allowed=h=>['127.0.0.1','localhost','::1','[::1]'].includes(String(h));
const originalFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(input instanceof Request?input.url:String(input));if(!allowed(u.hostname))throw Error('interview_external_network_blocked');return originalFetch(input,init)};
for(const module of [http,https])for(const key of ['request','get']){const original=module[key];module[key]=function(input,...args){const host=typeof input==='string'||input instanceof URL?new URL(input).hostname:input.hostname??input.host??'localhost';if(!allowed(String(host).split(':')[0]))throw Error('interview_external_network_blocked');return original.call(this,input,...args)}}
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const v=args[0];const host=typeof v==='object'&&!Array.isArray(v)?v.host:typeof args[1]==='string'?args[1]:null;if(host&&!allowed(host))throw Error('interview_external_network_blocked');return connect.apply(this,args)};
syncBuiltinESMExports();
