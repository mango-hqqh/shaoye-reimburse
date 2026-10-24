import { useEffect, useRef, useState } from 'react';
import { X, Check, ScanLine, ImageOff, FileText, Paperclip, ExternalLink, ChevronDown, LoaderCircle, AlertCircle, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import type { Editable, Receipt, Settings } from '../types';
import { api, CATEGORIES, STATUS_LABELS, STEPS, today, addDays, amount } from '../utils';
type Props={record:Receipt|null;settings:Settings;close:()=>void;saved:(r:Receipt)=>void;toast:(message:string,error?:boolean)=>void;invoiceCount?:number;manageInvoices?:()=>void;};
export default function ReceiptEditor({record,settings,close,saved,toast,invoiceCount=0,manageInvoices}:Props){
  const [current,setCurrent]=useState(record);
  const [form,setForm]=useState<Editable>(()=>record?{...record}:{title:'',merchant:'',amount:null,purchasedAt:today(),purchasedTime:'',category:'其他支出',status:'needs_invoice',invoiceDueDate:addDays(today(),settings.invoiceDays),reimbursementDueDate:addDays(today(),settings.reimbursementDays),orderNo:'',note:''});
  const [value,setValue]=useState(record?.amount===null||!record?'':String(record.amount));
  const [image,setImage]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[showText,setShowText]=useState(false),[zoom,setZoom]=useState(false);
  const fileRef=useRef<HTMLInputElement>(null),panelRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{let active=true;if(record)api.image(record.id).then(src=>{if(active)setImage(src);}).catch(e=>setError(e.message));return()=>{active=false;};},[record?.id]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    panelRef.current?.querySelector<HTMLInputElement>('input[name="title"]')?.focus();
    const handler=(e:KeyboardEvent)=>{
      if(e.key==='Escape'&&!busy)close();
      if(e.key==='Tab'){
        const nodes=panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]');
        if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
        if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
      }
    };
    document.addEventListener('keydown',handler);
    return()=>{document.removeEventListener('keydown',handler);previous?.focus();};
  },[busy,close]);
  const field=(key:keyof Editable,value:string)=>setForm(p=>({...p,[key]:value}));
  async function save(e:React.FormEvent){
    e.preventDefault();setError('');
    if(value.trim()===''||!/^\d+(?:\.\d{1,2})?$/.test(value)){setError('请输入有效金额，最多保留两位小数');return;}
    setBusy(true);
    try{const result=await api.saveReceipt({...form,amount:Number(value)});saved(result);close();toast(record?'账单已核对并保存':'已记下一笔消费');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function retry(){
    if(!current)return;setBusy(true);setError('');
    try{const result=await api.retryOcr(current.id);setCurrent(result);setForm({...result});setValue(result.amount===null?'':String(result.amount));toast('已重新识别，请核对结果');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function attach(file:File){
    if(!current)return;const previousStatus=current.status;setBusy(true);
    try{const result=await api.attachInvoice(current.id,{name:file.name,bytes:new Uint8Array(await file.arrayBuffer())});setCurrent(result);setForm(previous=>previous.status===previousStatus?{...previous,status:result.status}:previous);toast('发票附件已保存');}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)close();}}>
    <div className={'editor modal '+(!record?'manual-editor':'')} role="dialog" aria-modal="true" aria-labelledby="editor-title" ref={panelRef}>
      <header className="modal-header"><div><span className="eyebrow">{record?'RECEIPT DETAILS':'NEW EXPENSE'}</span><h2 id="editor-title">{record?(record.reviewed?'账单详情':'核对识别结果'):'手动记一笔'}</h2></div><button className="icon-button" onClick={close} disabled={busy} aria-label="关闭账单详情"><X size={21}/></button></header>
      <div className="editor-body">
        {record&&<aside className="receipt-preview">
          <div className="preview-top"><span><ScanLine size={15}/> 原始消费凭证</span>{image&&<button className="icon-button" onClick={()=>setZoom(!zoom)} title={zoom?'缩小图片':'放大图片'}>{zoom?<ZoomOut size={17}/>:<ZoomIn size={17}/>}</button>}</div>
          <div className={'image-frame '+(zoom?'zoomed':'')}>{image?<img src={image} alt="上传的消费凭证原图"/>:<div className="empty-image"><ImageOff size={36}/><p>这笔消费由手动录入</p></div>}</div>
          <div className="preview-caption"><span className="status-dot"/> 原图仅保存在此电脑</div>
          {record.imageId&&<><button className="text-button raw-toggle" onClick={()=>setShowText(!showText)}><FileText size={14}/> 查看识别原文 <ChevronDown size={14}/></button>{showText&&<pre className="raw-text">{current?.rawText||'未识别到文字'}</pre>}<button className="secondary-button retry-button" onClick={retry} disabled={busy}><RotateCcw size={14}/> 重新识别原图</button><p className="tiny-note">重新识别会更新商品、金额和日期，保留报销进度与提醒；请再次核对。</p></>}
        </aside>}
        <form id="receipt-form" className="receipt-form" onSubmit={save}>
          {record&&!current?.reviewed&&<div className="notice"><ScanLine size={17}/><div><strong>请核对识别结果</strong><p>请对照原图核对商品、实付金额和购买日期。</p>{!!current?.warnings.length&&<p className="warning-text">{current.warnings.join('；')}</p>}</div></div>}
          {error&&<div className="error-box" role="alert"><AlertCircle size={16}/>{error}</div>}
          <div className="form-grid">
            <label className="field full">商品 / 消费名称 <span>*</span><input name="title" value={form.title} onChange={e=>field('title',e.target.value)} required maxLength={200} placeholder="例如：罗技无线鼠标 / 上海出差车票"/></label>
            <label className="field">实付金额（人民币） <span>*</span><div className="money-input"><span>¥</span><input name="amount" inputMode="decimal" value={value} onChange={e=>setValue(e.target.value)} placeholder="0.00" required/></div></label>
            <label className="field">购买日期 <span>*</span><input name="purchasedAt" type="date" value={form.purchasedAt} min="1990-01-01" max="2100-12-31" required onChange={e=>{field('purchasedAt',e.target.value);}}/></label>
            <label className="field">商家名称<input value={form.merchant} onChange={e=>field('merchant',e.target.value)} placeholder="填写店铺或收款方" maxLength={200}/></label>
            <label className="field">支出分类<select value={form.category} onChange={e=>field('category',e.target.value)}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></label>
            <label className="field">购买时间（选填）<input type="time" step="1" value={form.purchasedTime||''} onChange={e=>field('purchasedTime',e.target.value)}/></label>
            <label className="field">订单编号<input value={form.orderNo} onChange={e=>field('orderNo',e.target.value)} placeholder="选填，方便回到订单申请发票" maxLength={100}/></label>
          </div>
          <div className="form-divider"><span>报销进度</span><span className="tiny-note">选择当前实际状态</span></div>
          <div className="status-steps">{STEPS.map((status,index)=><button type="button" key={status} className={form.status===status?'selected':''} onClick={()=>field('status',status)}><span>{index<STEPS.indexOf(form.status)?<Check size={12}/>:index+1}</span>{STATUS_LABELS[status]}</button>)}</div>
          <div className="form-grid dates-grid">
            <label className="field">开票提醒日期<input type="date" value={form.invoiceDueDate} min="1990-01-01" max="2100-12-31" required onChange={e=>field('invoiceDueDate',e.target.value)}/></label>
            <label className="field">报销 / 跟进提醒日期<input type="date" value={form.reimbursementDueDate} min="1990-01-01" max="2100-12-31" required onChange={e=>field('reimbursementDueDate',e.target.value)}/></label>
          </div>
          <label className="field">备注<textarea value={form.note} onChange={e=>field('note',e.target.value)} maxLength={2000} placeholder="例如：项目名称、报销用途、需要补充的材料…" rows={2}/></label>
          {current&&<div className="invoice-attachment"><div><Paperclip size={17}/><span>{current.invoiceId?current.invoiceName:'保存电子发票'}</span></div><div>{current.invoiceId&&<button type="button" className="text-button" onClick={()=>api.openInvoice(current.id).catch(e=>toast(e.message,true))}><ExternalLink size={13}/> 打开</button>}<button type="button" disabled={busy} className="text-button" onClick={()=>fileRef.current?.click()}>添加附件</button></div><input ref={fileRef} hidden type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp" onChange={e=>{if(e.target.files?.[0])void attach(e.target.files[0]);e.target.value='';}}/></div>}
          {current&&manageInvoices&&<div className="invoice-manage-entry"><span>{invoiceCount?`已关联 ${invoiceCount} 份发票，新增附件会一并保留。`:'支持关联多份发票，也可以前往发票管理批量导入。'}</span><button type="button" className="text-button" disabled={busy} onClick={manageInvoices}><FileText size={13}/>查看全部发票</button></div>}
          {current?.invoiceId&&<p className="tiny-note">上方“打开”查看首份发票；报销状态请按实际进度选择。</p>}
        </form>
      </div>
      <footer className="modal-footer"><span className="tiny-note">{form.amount!==null&&record?.reviewed?'已核对 · ¥ '+amount(record.amount):'核对后计入报销统计'}</span><div><button className="secondary-button" onClick={close} disabled={busy}>取消</button><button form="receipt-form" className="primary-button" type="submit" disabled={busy}>{busy?<LoaderCircle size={16} className="spin"/>:<Check size={16}/>} {busy?'正在处理…':'确认并保存'}</button></div></footer>
    </div>
  </div>;
}
