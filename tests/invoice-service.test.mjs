import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, mkdir} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {setImmediate as nextTurn} from 'node:timers/promises';

const require = createRequire(import.meta.url);
const {Store} = require('../electron/store.cjs');
const {InvoiceService} = require('../electron/invoice-service.cjs');
const {makeBackup, checkBackup, restoreBackup} = require('../electron/backup.cjs');
const {planInvoiceExport} = require('../electron/invoice-export.cjs');
const {fileExtension} = require('../electron/attachments.cjs');
const sharp = require('sharp');
const testRoot = resolve('test-results/invoice-service');
await mkdir(testRoot, {recursive:true});
const png = await readFile(new URL('./fixtures/receipt.png', import.meta.url));
const jpg = await sharp(png).jpeg({quality:85}).toBuffer();
// Syntactically distinct PDF byte fixtures. Text/OCR is deliberately supplied by
// the injected reader: these tests exercise persistence and linking, not PDF OCR.
const pdf = marker => Buffer.from('%PDF-1.4\n% test invoice ' + marker + '\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const parsed = (extra = {}) => ({amount:128.6, invoiceNo:'24332000000012345678', issuedAt:'2026-10-23', seller:'杭州鼎固五金有限公司', items:['304不锈钢内六角螺丝'], orderNos:[], rawText:'发票测试识别结果', warnings:[], ...extra});
const receipt = (extra = {}) => ({id:randomUUID(), title:'304不锈钢内六角螺丝 M4×20', merchant:'杭州鼎固五金有限公司', amount:128.6, purchasedAt:'2026-10-20', purchasedTime:'14:30:00', invoiceDueDate:'2026-10-27', reimbursementDueDate:'2026-11-19', status:'needs_invoice', category:'办公用品', reviewed:true, orderNo:'2398217645086312', note:'请原样保留', createdAt:'2026-10-20T06:30:00.000Z', updatedAt:'2026-10-20T06:30:00.000Z', deletedAt:null, reimbursedAt:null, imageId:null, invoiceId:null, invoiceName:'', sourceName:'购物截图.png', sourceHash:'', rawText:'原订单OCR文本', confidence:92, warnings:[], ...extra});

async function cleanup(folder) {
  const target = resolve(folder);
  if (!target.startsWith(testRoot + sep)) throw new Error('Unsafe invoice-service cleanup target');
  await rm(target, {recursive:true, force:true, maxRetries:3, retryDelay:100});
}
async function fixture(run) {
  const folder = await mkdtemp(join(testRoot, 'case-'));
  try { await run(new Store(folder), folder); }
  finally { await cleanup(folder); }
}
function service(store, result = parsed(), automatic = true) {
  return new InvoiceService(store, {}, bytes => assert.notEqual(fileExtension(bytes),'pdf'), async () => ({parsed:structuredClone(result), automatic}));
}
function billFields(record) {
  const {title, merchant, amount, purchasedAt, purchasedTime, orderNo, note, rawText, reviewed} = record;
  return {title, merchant, amount, purchasedAt, purchasedTime, orderNo, note, rawText, reviewed};
}

test('发票服务并发批量导入按内容去重，读取串行且重启全部保留', async () => fixture(async (store, folder) => {
  let calls=0, active=0, maximum=0;
  const importer=new InvoiceService(store, {}, () => {}, async () => {
    calls++; active++; maximum=Math.max(maximum,active); await nextTurn(); active--;
    return {parsed:parsed({invoiceNo:''}), automatic:true};
  });
  const files=[pdf('one'),pdf('two'),pdf('three')];
  const results=await Promise.all(Array.from({length:18},(_,index)=>importer.import(files[index%3],'同名发票.pdf')));
  assert.equal(calls,3); assert.equal(maximum,1); assert.equal(results.filter(value=>!value.duplicate).length,3);
  assert.equal(store.data.invoices.length,3); assert.equal(new Store(folder).data.invoices.length,3);
  assert.equal(new Set(store.data.invoices.map(value=>value.attachmentId)).size,3);
  assert.deepEqual(new Set(store.data.invoices.map(value=>value.name)),new Set(['同名发票.pdf']));
  for (const invoice of store.data.invoices) {
    const bytes=await store.attachment(invoice.attachmentId);
    assert.ok(files.some(original=>original.equals(bytes)));
    assert.equal(invoice.hash,createHash('sha256').update(bytes).digest('hex'));
  }
}));

test('JPG、PNG、PDF直接保留原始bytes和真实扩展名，不转换图片', async () => fixture(async store => {
  const importer=service(store);
  const cases=[[jpg,'手机原图.jpeg','jpg'],[png,'订单发票.png','png'],[pdf('original'),'电子发票.pdf','pdf']];
  for (const [bytes,name,extension] of cases) {
    const result=await importer.import(bytes,name);
    assert.equal(result.invoice.name,name); assert.equal(result.invoice.attachmentId.split('.').pop(),extension);
    assert.deepEqual(await store.attachment(result.invoice.attachmentId),bytes);
    assert.equal(result.invoice.hash,createHash('sha256').update(bytes).digest('hex'));
  }
  const renamed=await importer.import(pdf('wrong suffix'),'发票.jpg');
  assert.equal(renamed.invoice.name,'发票.pdf');
}));

test('自动关联只选未报销订单，且不覆盖已核对的金额、名称与购买日期', async () => fixture(async store => {
  const pending=receipt(), paid=receipt({status:'reimbursed',reimbursedAt:'2026-10-22T00:00:00.000Z'}), trash=receipt({deletedAt:'2026-10-22T00:00:00.000Z'});
  await store.update(data=>data.records.push(pending,paid,trash));
  const result=await service(store).import(pdf('automatic'),'发票.pdf');
  assert.equal(result.invoice.recordId,pending.id); assert.equal(result.matched,true);
  assert.deepEqual(billFields(store.data.records[0]),billFields(pending)); assert.equal(store.data.records[0].status,'ready');
  assert.equal(store.data.records[0].invoiceId,result.invoice.attachmentId);
  assert.equal(store.data.records[1].invoiceId,null); assert.equal(store.data.records[2].invoiceId,null);
}));

test('同金额歧义、未核对订单和不确定识别保留为未匹配，状态不前进', async () => fixture(async store => {
  const one=receipt(), two=receipt({title:'办公电脑支架',merchant:'其他公司'});
  await store.update(data=>data.records.push(one,two));
  const ambiguous=await service(store).import(pdf('ambiguous'),'同金额.pdf');
  assert.equal(ambiguous.invoice.recordId,null); assert.equal(ambiguous.candidates.length,2);
  await store.update(data=>{data.records=[receipt({reviewed:false})];});
  const draft=await service(store,parsed({invoiceNo:''})).import(pdf('draft'),'未核对.pdf');
  assert.equal(draft.invoice.recordId,null); assert.equal(store.data.records[0].status,'needs_invoice');
  await store.update(data=>{data.records[0].reviewed=true;});
  const uncertain=await service(store,parsed({invoiceNo:''}),false).import(pdf('uncertain'),'模糊票.pdf');
  assert.equal(uncertain.invoice.recordId,null); assert.equal(store.data.records[0].status,'needs_invoice');
  assert.deepEqual(await store.attachment(uncertain.invoice.attachmentId),pdf('uncertain'));
}));

test('人工给同一订单补挂多张发票不覆盖，解除与删除同步旧版附件指针', async () => fixture(async store => {
  const order=receipt(); await store.update(data=>data.records.push(order));
  const importer=service(store,parsed({invoiceNo:''}));
  const first=await importer.import(pdf('first'),'第一张.pdf',order.id);
  const second=await importer.import(jpg,'第二张.jpg',order.id);
  assert.equal(store.data.invoices.length,2); assert.ok(store.data.invoices.every(value=>value.recordId===order.id));
  assert.equal(store.data.records[0].invoiceId,first.invoice.attachmentId);
  assert.deepEqual(await store.attachment(first.invoice.attachmentId),pdf('first'));
  assert.deepEqual(await store.attachment(second.invoice.attachmentId),jpg);
  await importer.match(first.invoice.id,null);
  assert.equal(store.data.records[0].invoiceId,second.invoice.attachmentId); assert.equal(store.data.records[0].invoiceName,'第二张.jpg');
  await importer.remove(second.invoice.id);
  assert.equal(store.data.records[0].invoiceId,null); assert.equal(store.data.records[0].invoiceName,'');
  assert.ok(store.data.invoices.find(value=>value.id===second.invoice.id).deletedAt);
  assert.deepEqual(await store.attachment(second.invoice.attachmentId),jpg);
  await importer.match(first.invoice.id,order.id);
  assert.equal(store.data.records[0].invoiceId,first.invoice.attachmentId);
  assert.deepEqual(billFields(store.data.records[0]),billFields(order));
}));

test('已报销发票同文件重导、删除后重导和解除关联不能绕过导出排除', async () => fixture(async store => {
  const order=receipt(); await store.update(data=>data.records.push(order));
  const importer=service(store);
  const original=await importer.import(pdf('paid'),'已报销.pdf',order.id);
  await store.update(data=>{data.records[0].status='reimbursed';data.records[0].reimbursedAt='2026-10-23T00:00:00.000Z';});
  await assert.rejects(importer.match(original.invoice.id,null),/已报销/);
  assert.throws(()=>planInvoiceExport(store.snapshot()),/没有可导出的发票/);
  const duplicate=await importer.import(pdf('paid'),'换名字.pdf');
  assert.equal(duplicate.duplicate,true); assert.equal(duplicate.invoice.recordId,order.id);
  await importer.remove(original.invoice.id);
  const restored=await importer.import(pdf('paid'),'重新上传.pdf');
  assert.equal(restored.invoice.id,original.invoice.id); assert.equal(restored.invoice.recordId,order.id); assert.equal(restored.invoice.deletedAt,null);
  assert.throws(()=>planInvoiceExport(store.snapshot()),/没有可导出的发票/);
  const another=receipt({amount:77}); await store.update(data=>data.records.push(another));
  await assert.rejects(importer.import(pdf('paid'),'不能重复报销.pdf',another.id),/已关联其他订单|已报销/);
}));

test('已报销数电发票换格式重导仍归历史，不能通过详情补挂改投其他订单', async () => fixture(async store => {
  const paid=receipt(), other=receipt({amount:77}); await store.update(data=>data.records.push(paid,other));
  const importer=service(store);
  await importer.import(pdf('paid-source'),'原发票.pdf',paid.id);
  await store.update(data=>{data.records[0].status='reimbursed';});
  const alternate=await importer.import(jpg,'同票号截图.jpg');
  assert.equal(alternate.invoice.recordId,paid.id);
  await assert.rejects(importer.import(png,'同票号原图.png',other.id),/已报销|其他订单|历史发票/);
  assert.throws(()=>planInvoiceExport(store.snapshot()),/没有可导出的发票/);
}));

test('删除已报销数电发票后换格式导入也不能成为待报销票', async () => fixture(async store => {
  const paid=receipt(); await store.update(data=>data.records.push(paid));
  const importer=service(store);
  const original=await importer.import(pdf('paid-deleted'),'历史原票.pdf',paid.id);
  await store.update(data=>{data.records[0].status='reimbursed';});
  await importer.remove(original.invoice.id);
  const alternate=await importer.import(jpg,'历史票截图.jpg');
  assert.equal(alternate.invoice.recordId,paid.id);
  assert.throws(()=>planInvoiceExport(store.snapshot()),/没有可导出的发票/);
}));

test('报销前导入的同票号未匹配副本，在原单报销后也动态排除且禁止改挂', async () => fixture(async store => {
  const originalOrder=receipt(), otherOrder=receipt({amount:77});
  await store.update(data=>data.records.push(originalOrder,otherOrder));
  const importer=service(store);
  const original=await importer.import(pdf('pending-original'),'原始发票.pdf',originalOrder.id);
  const copy=await importer.import(jpg,'报销前保存的副本.jpg');
  assert.equal(copy.invoice.recordId,null);
  assert.equal(planInvoiceExport(store.snapshot()).invoiceCount,2);
  await store.update(data=>{data.records[0].status='reimbursed';});
  assert.throws(()=>planInvoiceExport(store.snapshot()),/没有可导出的发票/);
  await assert.rejects(importer.match(copy.invoice.id,otherOrder.id),/已报销/);
  await assert.rejects(importer.import(jpg,'同副本重新补挂.jpg',otherOrder.id),/已报销/);
  assert.equal(store.data.invoices.find(value=>value.id===copy.invoice.id).recordId,null);
  await importer.remove(original.invoice.id);
  assert.throws(()=>planInvoiceExport(store.snapshot()),/没有可导出的发票/);
  await assert.rejects(importer.match(copy.invoice.id,otherOrder.id),/已报销/);
}));

test('同票号副本先人工关联其他未报销订单，原单后来报销后副本也不再导出', async () => fixture(async store => {
  const originalOrder=receipt(), otherOrder=receipt({amount:77});
  await store.update(data=>data.records.push(originalOrder,otherOrder));
  const importer=service(store);
  await importer.import(pdf('pending-linked-original'),'原票.pdf',originalOrder.id);
  const copy=await importer.import(jpg,'另一格式副本.jpg');
  await importer.match(copy.invoice.id,otherOrder.id);
  assert.equal(planInvoiceExport(store.snapshot()).recordCount,2);
  await store.update(data=>{data.records[0].status='reimbursed';});
  assert.throws(()=>planInvoiceExport(store.snapshot()),/没有可导出的发票/);
  assert.equal(store.data.records[1].status,'ready');
  assert.equal(store.data.invoices.find(value=>value.id===copy.invoice.id).recordId,otherOrder.id);
}));

test('备份包含未匹配及红字发票原文件，恢复重命名附件但完整保留关联', async () => fixture(async (store, folder) => {
  const order=receipt(); await store.update(data=>data.records.push(order));
  const linked=await service(store).import(pdf('backup-linked'),'已关联.pdf',order.id);
  const unmatched=await service(store,parsed({amount:777,invoiceNo:'',seller:'不相关公司',items:[]})).import(jpg,'未匹配.jpg');
  const red=await service(store,parsed({amount:-128.6,invoiceNo:'',warnings:['红字发票请核对']})).import(png,'红字票.png');
  assert.equal(unmatched.invoice.recordId,null); assert.equal(red.invoice.recordId,null);
  const originalBytes=new Map();
  for (const invoice of store.data.invoices) originalBytes.set(invoice.id,await store.attachment(invoice.attachmentId));
  const backup=JSON.parse(await makeBackup(store));
  assert.equal(Object.keys(backup.attachments).length,3); assert.equal(checkBackup(backup).invoices.length,3);
  const before=store.snapshot(); await restoreBackup(store,backup);
  for (const invoice of store.data.invoices) {
    const previous=before.invoices.find(value=>value.id===invoice.id);
    assert.notEqual(invoice.attachmentId,previous.attachmentId); assert.equal(invoice.recordId,previous.recordId);
    assert.equal(invoice.name,previous.name); assert.equal(invoice.hash,previous.hash);
    assert.deepEqual(await store.attachment(invoice.attachmentId),originalBytes.get(invoice.id));
  }
  const restoredLinked=store.data.invoices.find(value=>value.id===linked.invoice.id);
  assert.equal(store.data.records[0].invoiceId,restoredLinked.attachmentId);
  assert.equal(store.data.invoices.find(value=>value.id===red.invoice.id).amount,-128.6);
  assert.deepEqual(new Store(folder).data.invoices,store.data.invoices);
  const invalid=structuredClone(backup); invalid.data.records[0].amount=-1;
  assert.throws(()=>checkBackup(invalid),/账单金额无效/);
}));

test('旧账本invoiceId迁移只注册一次，已转换PNG明确标记并保留实际文件', async () => fixture(async (store, folder) => {
  const convertedId=await store.putAttachment(png,'png'), originalId=await store.putAttachment(pdf('legacy'),'pdf');
  const converted=receipt({invoiceId:convertedId,invoiceName:'原来上传的照片.jpg'});
  const original=receipt({invoiceId:originalId,invoiceName:'原发票.pdf'});
  const legacy=store.snapshot(); delete legacy.invoices; legacy.records=[converted,original];
  await writeFile(join(folder,'ledger.json'),JSON.stringify(legacy));
  const migrated=new Store(folder); assert.equal(migrated.data.invoices.length,2);
  const photo=migrated.data.invoices.find(value=>value.recordId===converted.id);
  const document=migrated.data.invoices.find(value=>value.recordId===original.id);
  assert.equal(photo.legacyConverted,true); assert.equal(photo.name,'原来上传的照片.png');
  assert.ok(photo.warnings.some(value=>value.includes('无法还原'))); assert.deepEqual(await migrated.attachment(photo.attachmentId),png);
  assert.equal(document.legacyConverted,false); assert.equal(document.name,'原发票.pdf');
  migrated.migrateInvoices(); assert.equal(migrated.data.invoices.length,2);
  await migrated.update(()=>{}); assert.equal(new Store(folder).data.invoices.length,2);
  const backup=JSON.parse(await makeBackup(migrated)); await restoreBackup(migrated,backup);
  assert.equal(migrated.data.invoices.find(value=>value.recordId===converted.id).legacyConverted,true);
}));

test('导入失败不破坏后续队列，删除或已报销订单不能被手动重新匹配', async () => fixture(async store => {
  const pending=receipt(), paid=receipt({status:'reimbursed'}), trash=receipt({deletedAt:'2026-10-23T00:00:00.000Z'});
  await store.update(data=>data.records.push(pending,paid,trash));
  const importer=service(store,parsed({amount:222,invoiceNo:''}));
  await assert.rejects(importer.import(Buffer.from('not an invoice'),'假发票.pdf'),/请选择/);
  const saved=await importer.import(pdf('after-failure'),'可用发票.pdf'); assert.equal(saved.invoice.recordId,null);
  await assert.rejects(importer.match(saved.invoice.id,paid.id),/未报销/);
  await assert.rejects(importer.match(saved.invoice.id,trash.id),/回收站/);
  await assert.rejects(importer.import(pdf('trash-forced'),'回收站.pdf',trash.id),/回收站/);
  await importer.match(saved.invoice.id,pending.id); assert.equal(store.data.records[0].invoiceId,saved.invoice.attachmentId);
}));
