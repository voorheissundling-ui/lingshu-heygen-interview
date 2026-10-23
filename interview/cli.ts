import {seed,snapshot,executeLocal,scan} from './control.js';
const command=process.argv[2];
if(command==='seed')console.log(await seed());
else if(command==='status')console.log(JSON.stringify(await snapshot(),null,2));
else if(command==='render')console.log(await executeLocal());
else if(command==='scan')console.log(await scan());
else throw Error('command: seed | status | render | scan');
