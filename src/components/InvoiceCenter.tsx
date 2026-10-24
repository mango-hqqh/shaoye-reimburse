import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { AlertCircle, ArrowUpRight, Check, CheckCheck, ChevronLeft, ChevronRight, Download, FileCheck2, FileText, FolderOpen, Link2, LoaderCircle, Search, Trash2, Unlink, Upload, X } from 'lucide-react';
import type { Invoice, InvoiceCandidate, Receipt, Snapshot } from '../types';
import { amount, api, STATUS_LABELS } from '../utils';
import '../invoices.css';

export type InvoiceCenterHandle = {importFiles:(files:File[])=>void;openPicker:()=>void;};
type Props = {active:boolean;snapshot:Snapshot;refresh:()=>Promise<void>;toast:(message:string,error?:boolean)=>void;openRecord:(record:Receipt)=>void;recordFilter:string|null;clearRecordFilter:()=>void;};
type InvoiceFilter = 'all'|'unmatched'|'matched'|'reimbursed';
type ImportOutcome = {name:string;status:'matched'|'unmatched'|'duplicate'|'failed';detail:string;};
type Batch = {total:number;completed:number;running:boolean;name:string;progress:number;status:string;outcomes:ImportOutcome[];stopped:boolean;};
const errorMessage = (error:unknown)=>error instanceof Error?error.message:String(error);
const outcomeLabels = {matched:'成功匹配',unmatched:'待确认',duplicate:'重复，已跳过',failed:'导入失败'};
const invoiceNumbers=(invoice:Invoice)=>[invoice.invoiceNo,...(invoice.invoiceNos||[])].filter(value=>/^\d{20}$/.test(value));
const containsMultipleInvoices=(invoice:Invoice)=>(invoice.invoiceNos||[]).length>1||invoice.warnings.some(warning=>warning.includes('多张发票'));

const InvoiceCenter=forwardRef<InvoiceCenterHandle,Props>(function InvoiceCenter({active,snapshot,refresh,toast,openRecord,recordFilter,clearRecordFilter},ref){
  const [search,setSearch]=useState(''),[filter,setFilter]=useState<InvoiceFilter>('all'),[pageIndex,setPageIndex]=useState(0);
  const [batch,setBatch]=useState<Batch|null>(null),[busy,setBusy]=useState('');
  const [linkingId,setLinkingId]=useState<string|null>(null),[candidates,setCandidates]=useState<InvoiceCandidate[]>([]),[candidateLoading,setCandidateLoading]=useState(false),[chosenRecord,setChosenRecord]=useState('');
  const [removeTarget,setRemoveTarget]=useState<Invoice|null>(null);
  const fileRef=useRef<HTMLInputElement>(null),batchBusy=useRef(false),stopBatch=useRef(false),requestId=useRef(''),candidateRequest=useRef(0),removeDialog=useRef<HTMLDivElement>(null);
  const allInvoices=snapshot.invoices||[],invoices=allInvoices.filter(invoice=>!invoice.deletedAt);
  const records=new Map(snapshot.records.map(record=>[record.id,record]));
  const availableRecords=snapshot.records.filter(record=>!record.deletedAt&&record.status!=='reimbursed');
  // Include removed historical files so another copy cannot become eligible
  // for reimbursement merely because the first file was removed from the list.
  const paidInvoices=allInvoices.filter(invoice=>invoice.recordId&&records.get(invoice.recordId)?.status==='reimbursed');
  const paidNumbers=new Set(paidInvoices.flatMap(invoiceNumbers)),paidHashes=new Set(paidInvoices.map(invoice=>invoice.hash).filter(Boolean));
  const isReimbursedCopy=(invoice:Invoice)=>!!invoice.hash&&paidHashes.has(invoice.hash)||invoiceNumbers(invoice).some(number=>paidNumbers.has(number));
  const statusOf=(invoice:Invoice)=>{
    const record=invoice.recordId?records.get(invoice.recordId):undefined;
    if(isReimbursedCopy(invoice)||record?.status==='reimbursed')return 'reimbursed';
    if(record?.deletedAt)return 'deleted';
    if(containsMultipleInvoices(invoice))return 'unmatched';
    return !record?'unmatched':'matched';
  };
  const counts={all:invoices.length,unmatched:invoices.filter(invoice=>statusOf(invoice)==='unmatched').length,matched:invoices.filter(invoice=>statusOf(invoice)==='matched').length,reimbursed:invoices.filter(invoice=>statusOf(invoice)==='reimbursed').length};
  const exportable=invoices.filter(invoice=>['unmatched','matched'].includes(statusOf(invoice)));
  const locked=!!busy||!!batch?.running;

  useEffect(()=>api.onProgress(progress=>{
    if(progress.id!==requestId.current)return;
    setBatch(previous=>previous?.running?{...previous,progress:Math.max(0,Math.min(1,progress.progress)),status:progress.status.startsWith('正在')?progress.status:'正在识别发票内容'}:previous);
  }),[]);
  useEffect(()=>{setPageIndex(0);},[search,filter,recordFilter]);
  useEffect(()=>{
    if(!recordFilter)return;
    setSearch('');setFilter('all');
  },[recordFilter]);
  useEffect(()=>{
    if(!removeTarget)return;
    const dialog=removeDialog.current;
    const previous=document.activeElement as HTMLElement|null;
    dialog?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown=(event:KeyboardEvent)=>{
      if(event.key==='Escape'&&!busy){event.stopPropagation();setRemoveTarget(null);}
      if(event.key==='Tab'){
        const buttons=dialog?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
        if(!buttons?.length)return;
        const first=buttons[0],last=buttons[buttons.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',keydown);
    return()=>{document.removeEventListener('keydown',keydown);previous?.focus();};
  },[removeTarget,busy]);

  async function importFiles(files:File[]){
    if(!files.length)return;
    if(batchBusy.current||busy){toast('正在处理发票，请稍后再导入');return;}
    if(files.length>50){toast('一次最多导入 50 份发票，请分批选择',true);return;}
    batchBusy.current=true;stopBatch.current=false;
    const outcomes:ImportOutcome[]=[];
    setBatch({total:files.length,completed:0,running:true,name:'',progress:0,status:'准备导入',outcomes:[],stopped:false});
    try{
      for(const file of files){
        if(stopBatch.current)break;
        const id=crypto.randomUUID();requestId.current=id;
        setBatch(previous=>previous?{...previous,name:file.name,progress:0,status:'正在读取发票文件'}:previous);
        let outcome:ImportOutcome;
        try{
          if(!/\.(pdf|png|jpe?g|webp|bmp)$/i.test(file.name))throw new Error('请选择 PDF、PNG、JPG、WEBP 或 BMP 文件');
          if(file.size>20*1024*1024)throw new Error('文件超过 20 MB');
          if(!file.size)throw new Error('文件为空');
          const result=await api.importInvoice({name:file.name,bytes:new Uint8Array(await file.arrayBuffer()),requestId:id});
          outcome={name:file.name,status:result.duplicate?'duplicate':result.matched?'matched':'unmatched',detail:result.duplicate?'相同文件已在发票库中':result.invoice.matchReason||result.invoice.warnings.join('；')||(result.matched?'已关联消费订单':'请选择对应订单，或稍后确认')};
        }catch(error){outcome={name:file.name,status:'failed',detail:errorMessage(error)};}
        outcomes.push(outcome);
        setBatch(previous=>previous?{...previous,completed:outcomes.length,progress:0,outcomes:[...outcomes]}:previous);
      }
      await refresh();
      const matched=outcomes.filter(item=>item.status==='matched').length,unmatched=outcomes.filter(item=>item.status==='unmatched').length,duplicates=outcomes.filter(item=>item.status==='duplicate').length,failed=outcomes.filter(item=>item.status==='failed').length;
      toast(`发票导入${stopBatch.current?'已停止':'完成'}：匹配 ${matched}，待确认 ${unmatched}，重复 ${duplicates}，失败 ${failed}`,failed>0);
    }finally{
      requestId.current='';batchBusy.current=false;
      setBatch(previous=>previous?{...previous,running:false,stopped:stopBatch.current&&outcomes.length<files.length}:previous);
    }
  }
  useImperativeHandle(ref,()=>({importFiles:files=>{void importFiles(files);},openPicker:()=>{if(!batchBusy.current&&!busy)fileRef.current?.click();else toast('正在处理发票，请稍后再导入');}}));

  async function beginMatch(invoice:Invoice){
    if(statusOf(invoice)==='reimbursed'){toast('这份发票已用于报销，不能再次关联',true);return;}
    if(containsMultipleInvoices(invoice)){toast('文件包含多张发票，请拆分后重新导入',true);return;}
    const sequence=++candidateRequest.current;
    setLinkingId(invoice.id);setCandidates([]);setChosenRecord(invoice.recordId&&availableRecords.some(record=>record.id===invoice.recordId)?invoice.recordId:'');setCandidateLoading(true);
    try{
      const result=await api.invoiceCandidates(invoice.id);
      if(sequence===candidateRequest.current)setCandidates(result);
    }catch(error){if(sequence===candidateRequest.current)toast('未能读取匹配建议，可手动选择订单：'+errorMessage(error),true);}
    finally{if(sequence===candidateRequest.current)setCandidateLoading(false);}
  }
  function closeMatch(){candidateRequest.current++;setLinkingId(null);setCandidateLoading(false);setChosenRecord('');}
  async function match(invoice:Invoice,recordId:string|null){
    if(statusOf(invoice)==='reimbursed'){toast('已报销发票不能调整或解除关联',true);return;}
    if(recordId&&containsMultipleInvoices(invoice)){toast('文件包含多张发票，请拆分后重新导入',true);return;}
    setBusy(invoice.id);
    try{await api.matchInvoice(invoice.id,recordId);await refresh();closeMatch();toast(recordId?'发票已关联，已有发票一并保留':'已解除发票与订单的关联');}
    catch(error){toast(errorMessage(error),true);}
    finally{setBusy('');}
  }
  async function openFile(invoice:Invoice){
    try{await api.openInvoiceFile(invoice.id);}catch(error){toast(errorMessage(error),true);}
  }
  async function remove(){
    if(!removeTarget)return;
    setBusy(removeTarget.id);
    try{await api.removeInvoice(removeTarget.id);await refresh();if(linkingId===removeTarget.id)closeMatch();setRemoveTarget(null);toast('发票已移除，关联订单保持原状态');}
    catch(error){toast(errorMessage(error),true);}
    finally{setBusy('');}
  }
  async function exportPackage(){
    setBusy('export');
    try{
      const result=await api.exportInvoicePackage();
      if(result.exported)toast(`报销材料已导出：${result.invoiceCount} 份发票、${result.recordCount} 笔订单${result.unmatchedCount?'，其中 '+result.unmatchedCount+' 份发票待确认':''}`);
    }catch(error){toast(errorMessage(error),true);}
    finally{setBusy('');}
  }

  const query=search.trim().toLowerCase();
  const filtered=invoices.filter(invoice=>{
    const record=invoice.recordId?records.get(invoice.recordId):undefined;
    return (!recordFilter||invoice.recordId===recordFilter)&&(filter==='all'||statusOf(invoice)===filter)&&(!query||[invoice.name,invoice.seller,invoice.invoiceNo,...(invoice.invoiceNos||[]),...invoice.items,...invoice.orderNos,record?.title||'',record?.merchant||'',record?.orderNo||''].some(text=>text.toLowerCase().includes(query)));
  }).sort((left,right)=>right.createdAt.localeCompare(left.createdAt));
  const pageCount=Math.max(1,Math.ceil(filtered.length/10)),safePage=Math.min(pageIndex,pageCount-1),shown=filtered.slice(safePage*10,safePage*10+10);
  const orderedCandidates=[...availableRecords].sort((left,right)=>(candidates.find(item=>item.recordId===right.id)?.score||0)-(candidates.find(item=>item.recordId===left.id)?.score||0)||right.createdAt.localeCompare(left.createdAt));
  const summary=batch?{matched:batch.outcomes.filter(item=>item.status==='matched').length,unmatched:batch.outcomes.filter(item=>item.status==='unmatched').length,duplicate:batch.outcomes.filter(item=>item.status==='duplicate').length,failed:batch.outcomes.filter(item=>item.status==='failed').length}:null;
  return <section className="invoice-center" aria-label="发票管理">
    {active&&<input ref={fileRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp" hidden aria-label="选择发票文件" onChange={event=>{void importFiles(Array.from(event.target.files||[]));event.target.value='';}}/>}
    <div className="invoice-intake">
      <div className="invoice-intake-icon"><FileCheck2 size={29}/></div>
      <div className="invoice-intake-copy"><h2>发票归在一起，报销少找一遍。</h2><p>批量导入电子发票，自动寻找对应订单；需要确认的留给你决定。</p><span>PDF / PNG / JPG / WEBP / BMP · 每批最多 50 份 · 每份不超过 20 MB</span></div>
      <button className="primary-button" onClick={()=>fileRef.current?.click()} disabled={locked}><Upload size={16}/>{batch?.running?'正在导入…':'批量导入发票'}</button>
    </div>
    {batch&&summary&&<div className="invoice-batch" role="status" aria-live="polite">
      <div className="invoice-batch-heading"><strong>{batch.running?<><LoaderCircle className="spin" size={16}/> 正在处理 {Math.min(batch.completed+1,batch.total)} / {batch.total}</>:<><Check size={16}/> {batch.stopped?'已停止后续导入':'本次导入完成'} · 已处理 {batch.completed} / {batch.total}</>}</strong>{batch.running?<button className="text-button" onClick={()=>{stopBatch.current=true;toast('当前文件处理完成后停止导入');}}>停止后续</button>:<button className="icon-button" onClick={()=>setBatch(null)} aria-label="关闭导入结果"><X size={16}/></button>}</div>
      {batch.running&&<><p className="invoice-batch-current">{batch.name}</p><div className="progress-track"><div style={{width:Math.max(2,(batch.completed+batch.progress)/batch.total*100)+'%'}}/></div><p className="invoice-progress-caption">{batch.status} · 原文件保存在本机</p></>}
      <div className="invoice-import-counts"><span><CheckCheck size={14}/> 成功匹配 <b>{summary.matched}</b></span><span><Link2 size={14}/> 待确认 <b>{summary.unmatched}</b></span><span>重复 <b>{summary.duplicate}</b></span><span className={summary.failed?'invoice-error-count':''}>失败 <b>{summary.failed}</b></span></div>
      {!!batch.outcomes.length&&<details className="invoice-import-details"><summary>查看每份发票的处理结果</summary><ul>{batch.outcomes.map((outcome,index)=><li key={index}><strong title={outcome.name}>{outcome.name}</strong><span className={'invoice-outcome '+outcome.status}>{outcomeLabels[outcome.status]}</span><p>{outcome.detail}</p></li>)}</ul></details>}
    </div>}
    <div className="invoice-export-strip"><div><Download size={19}/><div><strong>一键整理提交报销的材料</strong><p>打包未报销订单的关联发票、五列清单；未匹配发票放入“待确认”文件夹。</p><span>自动排除已报销、已删除订单。导出后，仍由你按实际进度更新报销状态。</span></div></div><button className="secondary-button" disabled={locked||!exportable.length} onClick={()=>void exportPackage()}>{busy==='export'?<LoaderCircle size={15} className="spin"/>:<Download size={15}/>}导出报销材料 ZIP<span className="invoice-export-count">{exportable.length}</span></button></div>
    <div className="invoice-library ledger-card">
      <div className="section-heading"><h2>我的发票<span className="count-pill">{invoices.length}</span></h2><span className="invoice-library-note">一笔订单可以关联多份发票</span></div>
      <div className="filter-tabs">{([{id:'all',label:'全部'},{id:'unmatched',label:'待确认'},{id:'matched',label:'已匹配'},{id:'reimbursed',label:'已报销'}] as const).map(tab=><button key={tab.id} className={filter===tab.id?'active':''} onClick={()=>setFilter(tab.id)}>{tab.label}<span>{counts[tab.id]}</span></button>)}</div>
      <div className="invoice-library-toolbar"><label className="search-box"><Search size={16}/><input aria-label="搜索发票" value={search} onChange={event=>setSearch(event.target.value)} placeholder="搜索文件名、销售方、发票号或订单"/>{search&&<button className="icon-button" onClick={()=>setSearch('')} aria-label="清空发票搜索"><X size={14}/></button>}</label><span>{filtered.length} 份发票</span></div>
      {recordFilter&&<div className="invoice-record-filter"><Link2 size={14}/><span>正在查看：{records.get(recordFilter)?.title||'所选订单'}</span><button className="text-button" onClick={clearRecordFilter}>查看全部发票 <X size={13}/></button></div>}
      <div className="invoice-list">{shown.map(invoice=>{
        const record=invoice.recordId?records.get(invoice.recordId):undefined,status=statusOf(invoice),multiple=containsMultipleInvoices(invoice),associationBlocked=status==='reimbursed'||multiple,matching=linkingId===invoice.id&&!associationBlocked;
        return <article className="invoice-row" key={invoice.id}>
          <div className="invoice-file-info"><div className="invoice-file-heading"><span className="invoice-file-icon"><FileText size={20}/><small>{invoice.name.toLowerCase().endsWith('.pdf')?'PDF':'图片'}</small></span><div><strong title={invoice.name}>{invoice.name}</strong><span className={'invoice-state '+status}>{status==='matched'?'已匹配':status==='reimbursed'?'已报销':status==='deleted'?'订单已删除':'待确认'}</span></div></div><dl className="invoice-fields"><div><dt>发票金额</dt><dd className="invoice-money">{invoice.amount===null?'待核对':'¥ '+amount(invoice.amount)}</dd></div><div><dt>销售方</dt><dd>{invoice.seller||'未识别，请查看原文件'}</dd></div><div><dt>发票号</dt><dd>{invoice.invoiceNo||'未识别'}</dd></div>{invoice.issuedAt&&<div><dt>开票日期</dt><dd>{invoice.issuedAt}</dd></div>}</dl></div>
          <div className="invoice-association"><span className="invoice-section-label">关联订单</span>{record?<><button className="invoice-order-link" disabled={!!record.deletedAt} onClick={()=>openRecord(record)}><span>{record.title}</span><ArrowUpRight size={14}/></button><p className="invoice-order-meta">{record.amount===null?'金额待核对':'¥ '+amount(record.amount)} · {record.purchasedAt||'日期待核对'} · {record.reviewed?STATUS_LABELS[record.status]:'待核对'}</p></>:<p className="invoice-unmatched">{status==='reimbursed'?'相同发票已用于报销':'尚未关联消费订单'}</p>}<p className="invoice-match-reason">{status==='reimbursed'&&record?.status!=='reimbursed'?'相同票号或相同文件已用于已报销订单，不能再次关联。':invoice.matchReason||(record?'已关联此订单':'没有确定的唯一匹配，请选择对应订单。')}</p>{status==='deleted'&&<p className="invoice-excluded">关联订单已移入回收站，导出时跳过。</p>}{status==='reimbursed'&&<p className="invoice-excluded">此文件已用于报销，整份文件从默认导出中排除。</p>}{multiple&&<p className="invoice-excluded">一份文件中包含多张发票，请拆分后重新导入，暂不能关联订单。</p>}{!!invoice.warnings.length&&<details className="invoice-warnings"><summary><AlertCircle size={13}/> {invoice.warnings.length} 项信息待核对</summary><p>{invoice.warnings.join('；')}</p></details>}<div className="invoice-link-actions"><button className="text-button" disabled={locked||associationBlocked} onClick={()=>matching?closeMatch():void beginMatch(invoice)}><Link2 size={13}/>{matching?'收起关联':record?'调整关联':'关联订单'}</button>{invoice.recordId&&<button className="text-button muted" disabled={locked||status==='reimbursed'} onClick={()=>void match(invoice,null)}><Unlink size={13}/>解除关联</button>}</div></div>
          <div className="invoice-row-actions"><button className="secondary-button small" disabled={!!busy} onClick={()=>void openFile(invoice)} aria-label={'打开原文件 '+invoice.name}><FolderOpen size={14}/>打开原文件</button><button className="text-button danger-text" disabled={locked} onClick={()=>setRemoveTarget(invoice)} aria-label={'移除发票 '+invoice.name}><Trash2 size={13}/>移除</button></div>
          {matching&&<div className="invoice-match-panel"><div><strong>选择要关联的消费订单</strong><p>仅列出未报销且未删除的订单。新增关联会保留该订单已有的所有发票。</p></div>{candidateLoading&&<span className="invoice-candidate-loading"><LoaderCircle size={14} className="spin"/>正在查找建议</span>}<div className="invoice-match-controls"><select aria-label={'选择关联订单 '+invoice.name} value={chosenRecord} disabled={locked} onChange={event=>setChosenRecord(event.target.value)}><option value="">请选择对应订单</option>{orderedCandidates.map(item=><option key={item.id} value={item.id}>{candidates.some(candidate=>candidate.recordId===item.id)?'建议 · ':''}{item.title} · {item.amount===null?'金额待核对':'¥'+amount(item.amount)} · {item.purchasedAt}{!item.reviewed?' · 待核对':''}</option>)}</select><button className="primary-button" disabled={locked||!chosenRecord||!availableRecords.some(item=>item.id===chosenRecord)} onClick={()=>void match(invoice,chosenRecord)}>{busy===invoice.id?<LoaderCircle size={14} className="spin"/>:<Check size={14}/>}确认关联</button><button className="secondary-button" disabled={locked} onClick={closeMatch}>取消</button></div>{chosenRecord&&candidates.find(candidate=>candidate.recordId===chosenRecord)?.reason&&<p className="invoice-candidate-reason">匹配建议：{candidates.find(candidate=>candidate.recordId===chosenRecord)?.reason}</p>}{!availableRecords.length&&<p className="invoice-candidate-reason">暂无可关联的订单，请先在“全部账单”添加消费记录。</p>}</div>}
        </article>;
      })}</div>
      {!shown.length&&<div className="empty-state invoice-empty"><div className="empty-illustration"><FileCheck2 size={30}/><span><Check size={12}/></span></div><h3>{invoices.length?'没有符合条件的发票':'把电子发票放进来，报销材料就齐了'}</h3><p>{invoices.length?'试试调整筛选条件或搜索词。':'支持 PDF 和图片，匹配不确定时会保留原文件等待你确认。'}</p>{!invoices.length&&<button className="text-button" disabled={locked} onClick={()=>fileRef.current?.click()}>导入第一份发票 <ArrowUpRight size={14}/></button>}</div>}
      {!!shown.length&&<div className="table-footer"><span>共 {filtered.length} 份 · 发票原文件保存在此电脑</span><div><button className="icon-button" disabled={safePage===0} onClick={()=>setPageIndex(safePage-1)} aria-label="发票上一页"><ChevronLeft size={16}/></button><span>{safePage+1} / {pageCount}</span><button className="icon-button" disabled={safePage>=pageCount-1} onClick={()=>setPageIndex(safePage+1)} aria-label="发票下一页"><ChevronRight size={16}/></button></div></div>}
    </div>
    {removeTarget&&<div className="modal-backdrop" onClick={()=>!busy&&setRemoveTarget(null)}><div className="invoice-remove-modal modal" role="dialog" aria-modal="true" aria-labelledby="invoice-remove-title" ref={removeDialog} onClick={event=>event.stopPropagation()}><div className="invoice-remove-icon"><Trash2 size={25}/></div><h2 id="invoice-remove-title">移除这份发票？</h2><strong>{removeTarget.name}</strong><p>移除后不再出现在发票列表和报销材料包中。原文件会保留在本机，关联订单的报销状态保持不变。</p><div><button className="secondary-button" disabled={!!busy} onClick={()=>setRemoveTarget(null)}>取消</button><button className="primary-button" disabled={!!busy} onClick={()=>void remove()}>{busy?<LoaderCircle className="spin" size={15}/>:<Trash2 size={15}/>}确认移除</button></div></div></div>}
  </section>;
});
export default InvoiceCenter;
