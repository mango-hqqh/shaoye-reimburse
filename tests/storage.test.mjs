import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const testRoot=resolve('test-results/unit');await mkdir(testRoot,{recursive:true});
async function cleanup(folder){const target=resolve(folder);if(!target.startsWith(testRoot+sep))throw new Error('Unsafe cleanup target');await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
const {Store}=require('../electron/store.cjs');
const {makeBackup,restoreBackup,checkBackup}=require('../electron/backup.cjs');
const record={id:randomUUID(),title:'测试记录',merchant:'测试店',amount:12.34,purchasedAt:'2026-10-20',invoiceDueDate:'2026-10-27',reimbursementDueDate:'2026-11-19',category:'其他支出',status:'needs_invoice',reviewed:true,orderNo:'123456',note:'',createdAt:'2026-10-22T10:00:00.000Z',updatedAt:'2026-10-22T10:00:00.000Z',imageId:null,invoiceId:null,deletedAt:null,sourceName:'手动记账',sourceHash:'',rawText:'',confidence:100,warnings:[],invoiceName:''};
test('并发写入串行提交，重启后全部保留，失败不会改变状态',async()=>{
 const folder=await mkdtemp(join(testRoot,'shaoye-storage-'));
 try{const store=new Store(folder);await Promise.all(Array.from({length:20},(_,i)=>store.update(data=>data.records.push({...record,id:randomUUID(),title:String(i)}))));assert.equal(new Store(folder).data.records.length,20);await assert.rejects(store.update(()=>{throw new Error('simulated failure');}));assert.equal(store.data.records.length,20);assert.equal(JSON.parse(await readFile(join(folder,'ledger.json'),'utf8')).records.length,20);}
 finally{await cleanup(folder);}
});
test('损坏主账本时从上一版本恢复并保留损坏文件',async()=>{
 const folder=await mkdtemp(join(testRoot,'shaoye-recovery-'));
 try{const store=new Store(folder);await store.update(d=>d.records.push(record));await store.update(d=>d.records.push({...record,id:randomUUID()}));await writeFile(join(folder,'ledger.json'),'{broken');const reopened=new Store(folder);assert.equal(reopened.recovered,true);assert.equal(reopened.data.records.length,1);}
 finally{await cleanup(folder);}
});
test('备份含附件，恢复生成新文件名并保留内容',async()=>{
 const folder=await mkdtemp(join(testRoot,'shaoye-backup-'));
 try{const store=new Store(folder);const bytes=await readFile(new URL('./fixtures/receipt.png',import.meta.url));const imageId=await store.putAttachment(bytes);await store.update(d=>d.records.push({...record,imageId}));const raw=JSON.parse(await makeBackup(store));assert.equal(checkBackup(raw).records.length,1);await restoreBackup(store,raw);assert.notEqual(store.data.records[0].imageId,imageId);assert.deepEqual(await store.attachment(store.data.records[0].imageId),bytes);}
 finally{await cleanup(folder);}
});
test('拒绝路径穿越、缺失附件、无效金额、重复 ID 和伪造备份',async()=>{
 const folder=await mkdtemp(join(testRoot,'shaoye-validation-'));
 try{const store=new Store(folder);assert.throws(()=>store.attachmentPath('../../secrets'));await store.update(d=>d.records.push(record));const raw=JSON.parse(await makeBackup(store));assert.throws(()=>checkBackup({...raw,app:'foreign'}));const invalid=structuredClone(raw);invalid.attachments['../evil.png']='AAAA';assert.throws(()=>checkBackup(invalid));const missing=structuredClone(raw);missing.data.records[0].imageId=randomUUID()+'.png';assert.throws(()=>checkBackup(missing));const bad=structuredClone(raw);bad.data.records[0].amount=-1;assert.throws(()=>checkBackup(bad));raw.data.records.push(record);assert.throws(()=>checkBackup(raw));}
 finally{await cleanup(folder);}
});
