const {randomUUID,createHash}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs/promises');
const {fileExtension}=require('./attachments.cjs');
const {readInvoice}=require('./invoice-reader.cjs');
const {findInvoiceMatches}=require('../shared/invoices.cjs');
const {reimbursedInvoiceKeys,isReimbursedInvoice}=require('../shared/invoice-state.cjs');

function syncPointers(data){
  for(const record of data.records){
    const linked=data.invoices.filter(i=>i.recordId===record.id&&!i.deletedAt);
    const first=linked.find(i=>i.attachmentId===record.invoiceId)||linked[0];
    record.invoiceId=first?.attachmentId||null;record.invoiceName=first?.name||'';
  }
}
function ensureInvoice(data,id){
  const invoice=data.invoices.find(i=>i.id===id&&!i.deletedAt);
  if(!invoice)throw new Error('发票不存在或已移除');return invoice;
}
class InvoiceService {
  constructor(store,ocr,validateImage,reader=readInvoice){this.store=store;this.ocr=ocr;this.validateImage=validateImage;this.reader=reader;this.queue=Promise.resolve();}
  import(bytes,name,forcedRecordId=null,requestId=null){
    const job=this.queue.then(()=>this.importOne(bytes,name,forcedRecordId,requestId));
    this.queue=job.catch(()=>{});return job;
  }
  async importOne(bytes,name,forcedRecordId,requestId){
    const extension=fileExtension(bytes),hash=createHash('sha256').update(bytes).digest('hex');
    if(extension!=='pdf')this.validateImage(bytes);
    const forced=forcedRecordId&&this.store.data.records.find(r=>r.id===forcedRecordId&&!r.deletedAt);
    if(forcedRecordId&&!forced)throw new Error('目标订单不存在或已移入回收站');
    const old=this.store.data.invoices.find(i=>i.hash===hash);
    if(old){
      if(forcedRecordId&&old.recordId&&old.recordId!==forcedRecordId)throw new Error('该发票已关联其他订单，请在发票管理中核对后修改关联');
      const invoice=await this.store.update(data=>{
        const saved=data.invoices.find(i=>i.id===old.id);saved.deletedAt=null;
        if(forcedRecordId){
          if((saved.invoiceNos||[]).length>1)throw new Error('文件包含多张发票，请拆分后重新导入');
          if(isReimbursedInvoice(saved,reimbursedInvoiceKeys(data.records,data.invoices))&&data.records.find(r=>r.id===forcedRecordId)?.status!=='reimbursed')throw new Error('该票号已用于已报销订单，不能再次挂到其他订单');
          if(!data.records.some(r=>r.id===forcedRecordId&&!r.deletedAt))throw new Error('目标订单已移入回收站');
          saved.recordId=forcedRecordId;saved.matchReason='在订单详情中添加';
        }
        const record=data.records.find(r=>r.id===saved.recordId&&!r.deletedAt);
        if(record){if(record.reviewed&&record.status==='needs_invoice')record.status='ready';record.updatedAt=new Date().toISOString();}
        syncPointers(data);return saved;
      });
      return {invoice,duplicate:true,matched:!!invoice.recordId,candidates:this.candidates(invoice.id)};
    }
    const id=randomUUID();
    const {parsed,automatic}=await this.reader(bytes,this.ocr,typeof requestId==='string'?requestId.slice(0,100):id);
    const attachmentId=await this.store.putAttachment(bytes,extension);
    const baseName=String(name||('发票.'+extension)).split(/[\\/]/).pop().slice(0,240);
    const suffix=path.extname(baseName).toLowerCase().slice(1);
    const filename=(suffix===extension||extension==='jpg'&&suffix==='jpeg')?baseName:path.parse(baseName).name+'.'+extension;
    let candidates=[];
    let invoice;
    try{invoice=await this.store.update(data=>{
      let match=findInvoiceMatches({...parsed,id},data.records,data.invoices);
      candidates=match.candidates;
      if(!automatic)match={...match,recordId:null,reason:'识别未完成或不确定，请手动确认关联'};
      // Another format/scan of an existing invoice must not silently be used
      // for another order with the same amount.
      const sameNumber=parsed.invoiceNo&&data.invoices.find(i=>i.invoiceNo===parsed.invoiceNo&&data.records.some(r=>r.id===i.recordId&&r.status==='reimbursed'))
        ||parsed.invoiceNo&&data.invoices.find(i=>!i.deletedAt&&i.invoiceNo===parsed.invoiceNo);
      if(sameNumber){
        parsed.warnings.push('发票号码与已上传文件重复，请核对是否为同一张发票');
        match={...match,recordId:null,reason:'存在相同发票号码，需人工核对'};
        // A 20-digit digital invoice number is globally identifying; keep a
        // duplicate of an already reimbursed invoice out of submission exports.
        const paid=data.records.find(r=>r.id===sameNumber.recordId&&r.status==='reimbursed');
        if(paid&&/^\d{20}$/.test(parsed.invoiceNo)){
          if(forcedRecordId&&forcedRecordId!==paid.id)throw new Error('该票号已用于已报销订单，不能再次挂到其他订单');
          match={...match,recordId:paid.id,reason:'同票号已报销，归入历史发票'};
        }
      }
      if(forcedRecordId){
        if((parsed.invoiceNos||[]).length>1)throw new Error('文件包含多张发票，请拆分后重新导入');
        if(!data.records.some(r=>r.id===forcedRecordId&&!r.deletedAt))throw new Error('目标订单已移入回收站');
        match={...match,recordId:forcedRecordId,reason:'在订单详情中添加'};
      }
      const created={...parsed,id,attachmentId,name:filename,hash,recordId:match.recordId,matchReason:match.reason,createdAt:new Date().toISOString(),deletedAt:null};
      data.invoices.unshift(created);
      if(created.recordId){
        const record=data.records.find(r=>r.id===created.recordId);
        if(record.reviewed&&record.status==='needs_invoice')record.status='ready';
        record.updatedAt=new Date().toISOString();
      }
      syncPointers(data);return created;
    });}catch(error){
      // This fresh UUID belongs only to the failed import; never remove an
      // existing invoice or a user's source file when a ledger write fails.
      await fs.unlink(this.store.attachmentPath(attachmentId)).catch(()=>{});
      throw error;
    }
    return {invoice,duplicate:false,matched:!!invoice.recordId,candidates};
  }
  candidates(id){
    const data=this.store.data,invoice=ensureInvoice(data,id);
    return findInvoiceMatches(invoice,data.records,data.invoices).candidates;
  }
  async match(id,recordId){
    if(recordId!==null&&typeof recordId!=='string')throw new Error('订单标识无效');
    return this.store.update(data=>{
      const invoice=ensureInvoice(data,id);
      if(recordId&&(invoice.invoiceNos||[]).length>1)throw new Error('文件包含多张发票，请拆分后重新导入');
      if(recordId&&isReimbursedInvoice(invoice,reimbursedInvoiceKeys(data.records,data.invoices)))throw new Error('该票号已用于已报销订单，不能再次关联');
      const current=data.records.find(r=>r.id===invoice.recordId);
      if(current?.status==='reimbursed'&&recordId!==current.id)throw new Error('已报销发票不能重新关联；请先在原账单中调整实际报销状态');
      if(recordId){
        const record=data.records.find(r=>r.id===recordId&&!r.deletedAt&&r.status!=='reimbursed');
        if(!record)throw new Error('请选择未报销且不在回收站的订单');
        if(record.reviewed&&record.status==='needs_invoice')record.status='ready';
        record.updatedAt=new Date().toISOString();
      }
      invoice.recordId=recordId;invoice.matchReason=recordId?'手动确认关联':'已解除关联，等待确认';
      syncPointers(data);return invoice;
    });
  }
  async remove(id){
    await this.store.update(data=>{ensureInvoice(data,id).deletedAt=new Date().toISOString();syncPointers(data);});
  }
}
module.exports={InvoiceService,syncPointers,ensureInvoice};
