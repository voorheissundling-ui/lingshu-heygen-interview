import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';
const require=createRequire(import.meta.url);const nodeVersion=process.versions.node.split('.').map(Number);if(nodeVersion[0]<22||nodeVersion[0]===22&&nodeVersion[1]<19)throw Error('Node >=22.19 required');
const ffmpeg=require('ffmpeg-static');if(!ffmpeg||!existsSync(ffmpeg))throw Error('ffmpeg binary missing: reinstall with allowed package build scripts; see README');
const check=spawnSync(ffmpeg,['-hide_banner','-version'],{encoding:'utf8'});if(check.status!==0)throw Error('ffmpeg cannot run');
for(const name of ['tsx','sharp','@langchain/langgraph','express'])require.resolve(name);
console.log(JSON.stringify({doctor:'PASS',node:process.version,platform:process.platform,arch:process.arch,ffmpeg:check.stdout.split('\n')[0],note:'No real provider, database server or credentials required'},null,2));
