const fs=require('node:fs/promises');
const {validateEditable,validateSettings,STATUSES,CATEGORIES,validDate}=require('../shared/domain.cjs');
const {createHash}=require('node:crypto');
const {ATTACHMENT_ID:IMAGE_ID,validAttachment}=require('./attachments.cjs');
async function makeBackup(store){
  const data=store.snapshot();
  const attachments={};
  let total=0;
  const references=[...data.records.flatMap(r=>[r.imageId,r.invoiceId]),...(data.invoices||[]).map(i=>i.attachmentId)];
  for(const id of references){
      if(!id||attachments[id])continue;
      const bytes=await store.attachment(id);
      total+=bytes.length;
      if(total>200*1024*1024)throw new Error('附件超过 200 MB，请直接复制设置页中的数据目录进行完整备份');
      attachments[id]=bytes.toString('base64');
  }
  return JSON.stringify({app:'shaoye-reimburse',version:1,exportedAt:new Date().toISOString(),data,attachments});
}
function checkBackup(raw){
  if(!raw||raw.app!=='shaoye-reimburse'||raw.version!==1||raw.data?.version!==1||!Array.isArray(raw.data.records)||raw.data.records.length>50000)throw new Error('这不是有效的报销助手备份');
  const settings=validateSettings(raw.data.settings);
  const attachments=new Map();
  let total=0;
  for(const [id,base64] of Object.entries(raw.attachments||{})){
    if(!IMAGE_ID.test(id)||typeof base64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw new Error('备份中的附件无效');
    const bytes=Buffer.from(base64,'base64');
    if(bytes.length===0||bytes.length>80*1024*1024)throw new Error('备份附件大小无效');
    total+=bytes.length;
    if(total>200*1024*1024)throw new Error('备份附件总量超过 200 MB');
    if(!validAttachment(bytes,id.split('.').pop()))throw new Error('附件格式与内容不符');
    attachments.set(id,bytes);
  }
  const seen=new Set();
  const text=(value,max)=> typeof value==='string'?value.slice(0,max):'';
  const records=raw.data.records.map(r=>{
    if(!r||typeof r.id!=='string'||!/^[a-f0-9-]{36}$/.test(r.id)||seen.has(r.id))throw new Error('备份账单标识无效或重复');
    seen.add(r.id);
    if(!STATUSES.includes(r.status)||!CATEGORIES.includes(r.category)||!validDate(r.invoiceDueDate)||!validDate(r.reimbursementDueDate))throw new Error('备份账单字段无效');
    if(r.amount!==null&&(typeof r.amount!=='number'||!Number.isFinite(r.amount)||r.amount<0||r.amount>99999999||Math.abs(r.amount*100-Math.round(r.amount*100))>.00001))throw new Error('备份账单金额无效');
    if(r.purchasedAt!==''&&!validDate(r.purchasedAt))throw new Error('备份购买日期无效');
    const record={id:r.id,title:text(r.title,200),merchant:text(r.merchant,200),amount:r.amount,purchasedAt:r.purchasedAt,purchasedTime:text(r.purchasedTime,8),invoiceDueDate:r.invoiceDueDate,reimbursementDueDate:r.reimbursementDueDate,status:r.status,category:r.category,orderNo:text(r.orderNo,100),note:text(r.note,2000),reimbursedAt:r.status==='reimbursed'?text(r.reimbursedAt||r.updatedAt,40):null,reviewed:r.reviewed===true,createdAt:text(r.createdAt,40),updatedAt:text(r.updatedAt,40),deletedAt:text(r.deletedAt,40)||null,sourceName:text(r.sourceName,255),sourceHash:/^[a-f0-9]{64}$/.test(r.sourceHash)?r.sourceHash:'',rawText:text(r.rawText,50000),confidence:Math.min(100,Math.max(0,Number(r.confidence)||0)),warnings:Array.isArray(r.warnings)?r.warnings.map(s=>text(s,200)).slice(0,20):[],imageId:r.imageId||null,invoiceId:r.invoiceId||null,invoiceName:text(r.invoiceName,255)};
    for(const id of [record.imageId,record.invoiceId])if(id&&(!IMAGE_ID.test(id)||!attachments.has(id)))throw new Error('备份缺少引用的附件');
    if(record.reviewed)validateEditable(record);
    return record;
  });
  if(raw.data.invoices!==undefined&&(!Array.isArray(raw.data.invoices)||raw.data.invoices.length>50000))throw new Error('备份发票列表无效');
  const invoiceIds=new Set();
  const invoices=(raw.data.invoices||[]).map(i=>{
    if(!i||typeof i.id!=='string'||!/^[a-f0-9-]{36}$/.test(i.id)||invoiceIds.has(i.id))throw new Error('备份发票标识无效或重复');
    invoiceIds.add(i.id);
    if(!IMAGE_ID.test(i.attachmentId)||!attachments.has(i.attachmentId))throw new Error('备份缺少发票原文件');
    if(i.recordId!==null&&(!seen.has(i.recordId)||typeof i.recordId!=='string'))throw new Error('发票关联的账单不存在');
    if(i.amount!==null&&(typeof i.amount!=='number'||!Number.isFinite(i.amount)||Math.abs(i.amount)>99999999||Math.abs(i.amount*100-Math.round(i.amount*100))>.00001))throw new Error('发票金额无效');
    if(i.issuedAt!==''&&!validDate(i.issuedAt))throw new Error('发票日期无效');
    const list=(value,max)=>Array.isArray(value)?value.slice(0,max).map(v=>text(v,300)):[];
    return {id:i.id,attachmentId:i.attachmentId,name:text(i.name,255),hash:createHash('sha256').update(attachments.get(i.attachmentId)).digest('hex'),invoiceNo:text(i.invoiceNo,100),invoiceNos:list(i.invoiceNos,100),amount:i.amount,issuedAt:i.issuedAt,seller:text(i.seller,200),items:list(i.items,100),orderNos:list(i.orderNos,50),rawText:text(i.rawText,100000),warnings:list(i.warnings,30),recordId:i.recordId,matchReason:text(i.matchReason,500),createdAt:text(i.createdAt,40),deletedAt:text(i.deletedAt,40)||null,legacyConverted:i.legacyConverted===true};
  });
  return {records,invoices,settings,attachments};
}
async function restoreBackup(store,raw){
  const checked=checkBackup(raw);
  const mapping=new Map();
  // 始终使用新的内部文件名，不接受备份里的路径，不覆盖现有图片。
  for(const [id,bytes] of checked.attachments)mapping.set(id,await store.putAttachment(bytes,id.split('.').pop()));
  const records=checked.records.map(r=>({...r,imageId:mapping.get(r.imageId)||null,invoiceId:mapping.get(r.invoiceId)||null}));
  const invoices=checked.invoices.map(i=>({...i,attachmentId:mapping.get(i.attachmentId)}));
  await store.update(data=>{data.records=records;data.invoices=invoices;store.migrateInvoices(data);data.settings=checked.settings;data.lastNotification='';});
  return records.length;
}
module.exports={makeBackup,checkBackup,restoreBackup};
