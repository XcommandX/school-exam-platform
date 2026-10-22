import { readFile, writeFile } from 'node:fs/promises';
import { exportBank, importBank } from '../src/content/task-format.mjs';
const [action,source,destination,...extra]=process.argv.slice(2);
if (!['export','validate','import'].includes(action)||!source||extra.length||(['export','import'].includes(action)&&!destination)) throw new Error('Usage: node scripts/task-files.mjs export bank.json new-folder | validate folder [asset-root] | import folder new-bank.json');
if(action==='export') console.log(JSON.stringify(await exportBank(JSON.parse(await readFile(source,'utf8')),destination)));
else {const result=await importBank(source,action==='validate'?{assetRoot:destination}:{});if(action==='import')await writeFile(destination,JSON.stringify(result.bank,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(result.report));}
