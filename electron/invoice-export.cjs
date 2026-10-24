const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {Readable}=require('node:stream');
const {pipeline,finished}=require('node:stream/promises');
const {ZipFile}=require('yazl');
const {validDate}=require('../shared/domain.cjs');
const {reimbursedInvoiceKeys,isReimbursedInvoice}=require('../shared/invoice-state.cjs');

const CSV_HEADERS=['商品 / 消费','商家','金额（CNY）','购买日期','备注'];
const RESERVED=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const shorten=(text,max)=>Array.from(text).slice(0,max).join('');

function safePart(value,fallback='未命名'){
  let name=String(value||'').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').trim().replace(/[. ]+$/g,'');
  if(!name||/^\.+$/.test(name))name=fallback;
  if(RESERVED.test(name))name='_'+name;
  return shorten(name,120).replace(/[. ]+$/g,'')||fallback;
}

function safeInvoiceName(invoice){
  // Only retain the leaf, including for Windows paths when running on another OS.
  const leaf=String(invoice.name||'').split(/[\\/]/).at(-1)||'';
  const normalized=leaf.normalize('NFKC').trim().replace(/[. ]+$/g,'');
  const originalExtension=path.posix.extname(normalized);
  const fallbackExtension=path.posix.extname(String(invoice.attachmentId||'').replace(/\\/g,'/'));
  const extension=(originalExtension||fallbackExtension).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_');
  const rawStem=originalExtension?normalized.slice(0,-originalExtension.length):normalized;
  // Preserve the original extension while bounding the complete filename.
  return shorten(safePart(rawStem,'发票'),Math.max(1,120-Array.from(extension).length))+extension;
}

function uniquePath(directory,name,used){
  const extension=path.posix.extname(name),stem=extension?name.slice(0,-extension.length):name;
  let result=directory+'/'+name,sequence=1;
  while(used.has(result.normalize('NFC').toLocaleLowerCase('en-US'))){
    sequence++;
    result=directory+'/'+shorten(stem,Math.max(1,110-Array.from(extension).length))+' ('+sequence+')'+extension;
  }
  used.add(result.normalize('NFC').toLocaleLowerCase('en-US'));
  return result;
}

function csvCell(value){
  let text=String(value??'');
  if(/^\s*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}

function reportCsv(records){
  const rows=[CSV_HEADERS];
  for(const record of records){
    if(typeof record.amount!=='number'||!Number.isFinite(record.amount)||record.amount<0||record.amount>99999999||Math.abs(record.amount*100-Math.round(record.amount*100))>0.00001){
      throw new Error('已核对订单“'+String(record.title||'未命名')+'”的金额无效，请修正后导出');
    }
    if(!validDate(record.purchasedAt))throw new Error('已核对订单“'+String(record.title||'未命名')+'”的购买日期无效，请修正后导出');
    const [year,month,day]=record.purchasedAt.split('-').map(Number);
    rows.push([record.title,record.merchant,record.amount.toFixed(2),year+'/'+month+'/'+day,record.note]);
  }
  return '\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

/** Build an export preview from a snapshot without reading files or changing it. */
function planInvoiceExport(data){
  const records=Array.isArray(data?.records)?data.records:[];
  const invoices=Array.isArray(data?.invoices)?data.invoices:[];
  const recordMap=new Map(records.map(record=>[record.id,record]));
  const reimbursed=reimbursedInvoiceKeys(records,invoices);
  const selected=[];
  let unmatchedCount=0,unreviewedCount=0;
  for(const invoice of invoices){
    if(!invoice||invoice.deletedAt||isReimbursedInvoice(invoice,reimbursed))continue;
    const record=invoice.recordId?recordMap.get(invoice.recordId):undefined;
    if(record&&(record.deletedAt||record.status==='reimbursed'))continue;
    if(!invoice.attachmentId||typeof invoice.attachmentId!=='string')throw new Error('发票“'+String(invoice.name||'未命名')+'”缺少附件，无法导出报销包');
    if(!record)unmatchedCount++;
    else if(record.reviewed!==true)unreviewedCount++;
    selected.push({invoice,record,confirmed:!!record&&record.reviewed===true&&(invoice.invoiceNos||[]).length<=1});
  }
  if(!selected.length)throw new Error('没有可导出的发票；已报销或回收站订单的发票不会导出');

  const includedIds=new Set(selected.filter(item=>item.confirmed).map(item=>item.record.id));
  const includedRecords=records.filter(record=>includedIds.has(record.id)).map(record=>({...record}));
  const directories=new Map(includedRecords.map((record,index)=>[record.id,'发票/'+String(index+1).padStart(3,'0')+'_'+safePart(record.title,'未命名消费')]));
  const used=new Set();
  const entries=selected.map(({invoice,record,confirmed})=>({
    invoiceId:invoice.id,attachmentId:invoice.attachmentId,name:String(invoice.name||'发票'),
    recordId:record?.id||null,confirmed,
    path:uniquePath(confirmed?directories.get(record.id):'待确认发票',safeInvoiceName(invoice),used)
  }));
  return {
    invoiceCount:entries.length,recordCount:includedRecords.length,unmatchedCount,unreviewedCount,
    entries,records:includedRecords,csv:reportCsv(includedRecords)
  };
}

function exportNotes(plan){
  return [
    '少爷今天报销了吗 · 报销包导出说明',
    '',
    '发票文件：'+plan.invoiceCount+' 个',
    '报销清单：'+plan.recordCount+' 笔已核对、未报销订单',
    '未匹配发票：'+plan.unmatchedCount+' 个',
    '关联未核对订单的发票：'+plan.unreviewedCount+' 个',
    '',
    '报销清单.csv 严格包含五列：商品 / 消费、商家、金额（CNY）、购买日期、备注。',
    '清单仅列入有发票的已核对、未报销订单；同一订单多张发票只列一行，不重复计算金额。',
    '“发票”目录按清单订单编号和商品名称分组，保留发票原文件格式与原始内容。',
    '“待确认发票”目录存放未匹配或关联未核对订单的发票；这些发票和猜测金额均不计入清单。',
    '已报销订单、回收站订单及已删除发票已排除。导出不改变账单或发票状态。',
    '重名文件自动添加序号；路径和 Windows 不允许的文件名字符已清理。',
    'CSV 使用 UTF-8 BOM 编码，文本中可能被表格软件当作公式的开头已添加单引号保护。',
    '如需将待确认发票计入报销清单，请先在应用内匹配订单并核对，再重新导出。',
    ''
  ].join('\r\n');
}

/** Stream original attachment bytes to a sibling temporary ZIP, then replace atomically. */
async function exportInvoicePackage(store,destination){
  if(typeof destination!=='string'||!destination.trim())throw new Error('请选择报销包的保存位置');
  const plan=planInvoiceExport(await store.snapshot());
  const target=path.resolve(destination);
  const temporary=path.join(path.dirname(target),'.'+path.basename(target)+'.'+randomUUID()+'.tmp');
  const zip=new ZipFile(),active=new Set(),pending=new Set();
  let aborted=false,created=false,output,writing;
  zip.on('error',error=>zip.outputStream.destroy(error));
  try{
    // Reserve our own temporary path before attaching stream producers.
    const handle=await fs.promises.open(temporary,'wx',0o600);
    created=true;
    await handle.close();
    output=fs.createWriteStream(temporary,{flags:'r+'});
    writing=pipeline(zip.outputStream,output);
    // Attach a rejection handler immediately while entries are being registered.
    writing.catch(()=>{});
    zip.addBuffer(Buffer.from(plan.csv,'utf8'),'报销清单.csv');
    zip.addBuffer(Buffer.from('\ufeff'+exportNotes(plan),'utf8'),'导出说明.txt');
    for(const entry of plan.entries){
      zip.addReadStreamLazy(entry.path,{compress:false},done=>{
        const operation=(async()=>{
          let attachmentHandle,source;
          try{
            if(aborted)throw new Error('导出已停止');
            if(typeof store.attachmentPath==='function'){
              attachmentHandle=await fs.promises.open(store.attachmentPath(entry.attachmentId),'r');
              const stat=await attachmentHandle.stat();
              if(!stat.isFile()||stat.size===0)throw new Error('附件为空或不是文件');
              if(aborted)throw new Error('导出已停止');
              source=attachmentHandle.createReadStream({autoClose:true});
              attachmentHandle=null;
            }else{
              const bytes=await store.attachment(entry.attachmentId);
              if(!(Buffer.isBuffer(bytes)||bytes instanceof Uint8Array)||!bytes.byteLength)throw new Error('附件为空或无法读取');
              if(aborted)throw new Error('导出已停止');
              // Fallback stores expose one attachment buffer at a time, never the whole package.
              source=Readable.from([bytes]);
            }
            active.add(source);
            source.once('close',()=>active.delete(source));
            // yazl's lazy-stream API expects the caller to forward source errors.
            source.once('error',error=>zip.emit('error',new Error('发票“'+entry.name+'”附件读取失败，报销包未导出：'+error.message,{cause:error})));
            done(null,source);
          }catch(error){
            if(attachmentHandle)await attachmentHandle.close().catch(()=>{});
            if(source)source.destroy();
            done(new Error('发票“'+entry.name+'”附件读取失败，报销包未导出：'+error.message,{cause:error}));
          }
        })();
        pending.add(operation);
        operation.finally(()=>pending.delete(operation)).catch(error=>zip.outputStream.destroy(error));
      });
    }
    zip.end();
    await writing;
    const completed=await fs.promises.open(temporary,'r+');
    try{await completed.sync();}finally{await completed.close();}
    // Never unlink the old destination as a fallback: a failed rename keeps it intact.
    await fs.promises.rename(temporary,target);
    created=false;
    return {invoiceCount:plan.invoiceCount,recordCount:plan.recordCount,unmatchedCount:plan.unmatchedCount};
  }catch(error){
    aborted=true;
    zip.outputStream.destroy();
    if(output)output.destroy();
    const closing=[];
    for(const source of active){closing.push(finished(source).catch(()=>{}));source.destroy();}
    await Promise.allSettled([...pending,...closing]);
    if(writing)await writing.catch(()=>{});
    if(created)await fs.promises.unlink(temporary).catch(()=>{});
    throw error;
  }
}

module.exports={planInvoiceExport,exportInvoicePackage};
