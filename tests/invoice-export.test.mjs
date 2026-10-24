import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {resolve,join,sep,posix} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const yauzl=require('yauzl');
const {planInvoiceExport,exportInvoicePackage}=require('../electron/invoice-export.cjs');
const testRoot=resolve('test-results/invoice-export-unit');
const pdf=Buffer.from('%PDF-1.7\nOriginal invoice\0\n%%EOF','utf8');
const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,16,74,70,73,70,0,255,217]);
const baseRecord={id:'order-1',title:'304不锈钢螺丝',merchant:'测试五金店',amount:128.6,purchasedAt:'2026-09-09',note:'测试备注',status:'ready',reviewed:true,deletedAt:null};

async function sandbox(t){
  await mkdir(testRoot,{recursive:true});
  const folder=await mkdtemp(join(testRoot,'case-'));
  t.after(async()=>{
    const target=resolve(folder);
    if(!target.startsWith(testRoot+sep))throw new Error('Unsafe test cleanup target');
    await rm(target,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  return folder;
}

function fakeStore(data,files={}){
  return {
    data,reads:[],snapshot(){return structuredClone(this.data);},
    async attachment(id){
      this.reads.push(id);
      if(!Object.hasOwn(files,id))throw new Error('ENOENT: missing test attachment '+id);
      return files[id];
    }
  };
}

function openZip(file){
  return new Promise((resolveZip,reject)=>yauzl.open(file,{lazyEntries:true,strictFileNames:true},(error,zip)=>{
    if(error){reject(error);return;}
    const entries=new Map();let ended=false;
    const fail=error=>{zip.close();reject(error);};
    zip.on('error',fail);
    zip.on('end',()=>{ended=true;});
    zip.on('close',()=>{if(ended)resolveZip(entries);});
    zip.on('entry',entry=>zip.openReadStream(entry,(error,stream)=>{
      if(error){fail(error);return;}
      const chunks=[];
      stream.on('data',chunk=>chunks.push(chunk));
      stream.on('error',fail);
      stream.on('end',()=>{assert.ok(!entries.has(entry.fileName));entries.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});
    }));
    zip.readEntry();
  }));
}

// Parse CSV independently to exercise quoted commas/newlines and escaped quotes.
function csvRows(bytes){
  const text=bytes.toString('utf8').replace(/^\ufeff/,'');
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(char==='"'){
      if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;
    }else if(char===','&&!quoted){row.push(cell);cell='';}
    else if((char==='\r'||char==='\n')&&!quoted){
      if(char==='\r'&&text[i+1]==='\n')i++;
      row.push(cell);rows.push(row);row=[];cell='';
    }else cell+=char;
  }
  assert.equal(quoted,false,'CSV quotes must be balanced');
  if(row.length||cell){row.push(cell);rows.push(row);}
  return rows;
}

test('实际ZIP导出原始PDF/JPEG：多票同单金额不重复，已报销和回收站排除',async t=>{
  const folder=await sandbox(t),destination=join(folder,'报销包.zip');
  const data={records:[baseRecord,{...baseRecord,id:'unchecked',reviewed:false,amount:999},{...baseRecord,id:'paid',status:'reimbursed'},{...baseRecord,id:'trash',deletedAt:'2026-10-23'},{...baseRecord,id:'no-invoice'}],invoices:[
    {id:'i1',attachmentId:'a1.pdf',name:'电子发票.pdf',recordId:'order-1'},
    {id:'i2',attachmentId:'a2.pdf',name:'电子发票.pdf',recordId:'order-1'},
    {id:'i3',attachmentId:'a3.jpeg',name:'拍摄发票.jpeg',recordId:'order-1'},
    {id:'i4',attachmentId:'a4.pdf',name:'待核对.pdf',recordId:'unchecked'},
    {id:'i5',attachmentId:'a5.pdf',name:'未匹配.pdf',recordId:null},
    {id:'i6',attachmentId:'a6.pdf',name:'找不到订单.pdf',recordId:'missing-order'},
    {id:'paid',attachmentId:'must-not-read-paid',name:'已报销.pdf',recordId:'paid'},
    {id:'trash',attachmentId:'must-not-read-trash',name:'已删除订单.pdf',recordId:'trash'},
    {id:'deleted',attachmentId:'must-not-read-deleted',name:'已删发票.pdf',recordId:'order-1',deletedAt:'2026-10-23'}
  ]};
  const files={'a1.pdf':pdf,'a2.pdf':Buffer.concat([pdf,Buffer.from('\nsecond')]),'a3.jpeg':jpeg,'a4.pdf':pdf,'a5.pdf':pdf,'a6.pdf':pdf};
  const store=fakeStore(data,files),before=structuredClone(data),plan=planInvoiceExport(data);
  assert.equal(plan.invoiceCount,6);assert.equal(plan.recordCount,1);assert.equal(plan.unmatchedCount,2);assert.equal(plan.unreviewedCount,1);
  assert.deepEqual(await exportInvoicePackage(store,destination),{invoiceCount:6,recordCount:1,unmatchedCount:2});
  assert.deepEqual(data,before,'export must never change reimbursement state');
  const zip=await openZip(destination);
  assert.equal(zip.size,8);
  for(const entry of plan.entries)assert.deepEqual(zip.get(entry.path),files[entry.attachmentId]);
  assert.ok(zip.has('发票/001_304不锈钢螺丝/电子发票.pdf'));
  assert.ok(zip.has('发票/001_304不锈钢螺丝/电子发票 (2).pdf'));
  assert.ok(zip.has('发票/001_304不锈钢螺丝/拍摄发票.jpeg'));
  assert.equal([...zip.keys()].filter(name=>name.startsWith('待确认发票/')).length,3);
  assert.deepEqual(store.reads.sort(),Object.keys(files).sort());
  const csv=zip.get('报销清单.csv');
  assert.deepEqual([...csv.subarray(0,3)],[0xef,0xbb,0xbf]);
  const rows=csvRows(csv);
  assert.deepEqual(rows,[['商品 / 消费','商家','金额（CNY）','购买日期','备注'],['304不锈钢螺丝','测试五金店','128.60','2026/9/9','测试备注']]);
  assert.match(zip.get('导出说明.txt').toString('utf8'),/未匹配发票：2 个/);
  assert.match(zip.get('导出说明.txt').toString('utf8'),/猜测金额均不计入清单/);
});

test('清洗路径穿越、Windows保留名和非法字符，同名大小写文件不覆盖',async t=>{
  const folder=await sandbox(t);
  const names=['../../CON.pdf','C:\\Windows\\NUL.jpeg','a/b/电子发票.PDF','电子发票.pdf','发票<>:"|?*.png','..','\\..\\LPT1.pdf','nested\\report.pdf. '];
  const data={records:[{...baseRecord,title:'../CON:<危险>|消费?*'}],invoices:names.map((name,index)=>({id:String(index),attachmentId:String(index)+'.pdf',name,recordId:index<6?'order-1':null}))};
  const files=Object.fromEntries(data.invoices.map((invoice,index)=>[invoice.attachmentId,Buffer.concat([pdf,Buffer.from(String(index))])])),store=fakeStore(data,files);
  const plan=planInvoiceExport(data),destination=join(folder,'safe.zip');
  await exportInvoicePackage(store,destination);
  const entries=await openZip(destination),seen=new Set();
  for(const entry of plan.entries){
    assert.deepEqual(entries.get(entry.path),files[entry.attachmentId]);
    assert.ok(!entry.path.includes('\\'));assert.ok(!entry.path.startsWith('/'));assert.equal(posix.normalize(entry.path),entry.path);
    for(const component of entry.path.split('/')){
      assert.ok(component!=='.'&&component!=='..');assert.ok(!/[<>:"\\|?*\u0000-\u001f]/.test(component));
      assert.ok(!/[. ]$/.test(component));assert.ok(!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component));
    }
    const folded=entry.path.toLowerCase();assert.ok(!seen.has(folded));seen.add(folded);
  }
  assert.ok(plan.entries[0].path.endsWith('/_CON.pdf'));assert.ok(plan.entries[1].path.endsWith('/_NUL.jpeg'));
  assert.ok(plan.entries[2].path.endsWith('/电子发票.PDF'));assert.ok(plan.entries[3].path.endsWith('/电子发票 (2).pdf'));
});

test('CSV严格五列，日期无前导零，特殊文本RFC4180引用并保护公式',async t=>{
  const folder=await sandbox(t);
  const record={...baseRecord,title:'=HYPERLINK("x","y")',merchant:' @SUM(1,2)',note:'第一行,含逗号\r\n第二行"引号"',amount:0,purchasedAt:'2026-01-02'};
  const second={...baseRecord,id:'second',title:'普通消费',merchant:'\t危险开头',note:'\n=1+1',amount:9.9};
  const store=fakeStore({records:[record,second],invoices:[{id:'1',attachmentId:'1',name:'1.pdf',recordId:record.id},{id:'2',attachmentId:'2',name:'2.pdf',recordId:second.id}]},{'1':pdf,'2':pdf});
  const destination=join(folder,'csv.zip');await exportInvoicePackage(store,destination);
  const zip=await openZip(destination),rows=csvRows(zip.get('报销清单.csv'));
  assert.equal(rows.length,3);assert.ok(rows.every(row=>row.length===5));
  assert.deepEqual(rows[1],["'=HYPERLINK(\"x\",\"y\")","' @SUM(1,2)",'0.00','2026/1/2',record.note]);
  assert.deepEqual(rows[2],['普通消费',"'\t危险开头",'9.90','2026/9/9',"'\n=1+1"]);
});

test('仅未匹配或未核对发票时仍可导出，CSV只有表头，不计入猜测金额',async t=>{
  const folder=await sandbox(t),destination=join(folder,'pending.zip');
  const store=fakeStore({records:[{...baseRecord,reviewed:false,amount:null}],invoices:[{id:'1',attachmentId:'1',name:'未核对.pdf',recordId:'order-1'},{id:'2',attachmentId:'2',name:'未匹配.pdf',recordId:null}]},{'1':pdf,'2':pdf});
  assert.deepEqual(await exportInvoicePackage(store,destination),{invoiceCount:2,recordCount:0,unmatchedCount:1});
  const zip=await openZip(destination);assert.equal(csvRows(zip.get('报销清单.csv')).length,1);
  assert.ok(zip.has('待确认发票/未核对.pdf'));assert.ok(zip.has('待确认发票/未匹配.pdf'));
});

test('没有可导出发票时明确失败，已报销订单附件不会被读取',async t=>{
  const folder=await sandbox(t),destination=join(folder,'keep.zip');await writeFile(destination,'old destination');
  for(const data of [{records:[],invoices:[]},{records:[{...baseRecord,status:'reimbursed'}],invoices:[{id:'1',attachmentId:'missing',name:'paid.pdf',recordId:'order-1'}]}]){
    const store=fakeStore(data);await assert.rejects(exportInvoicePackage(store,destination),/没有可导出的发票/);assert.deepEqual(store.reads,[]);
    assert.equal(await readFile(destination,'utf8'),'old destination');
  }
  assert.deepEqual(await readdir(folder),['keep.zip']);
});

test('任一附件缺失则整包失败，保留旧目标且清理自己创建的临时文件',async t=>{
  const folder=await sandbox(t),destination=join(folder,'keep.zip');
  await writeFile(destination,'old destination');await writeFile(join(folder,'unrelated.tmp'),'do not delete');
  const store=fakeStore({records:[baseRecord],invoices:[{id:'1',attachmentId:'present',name:'存在.pdf',recordId:'order-1'},{id:'2',attachmentId:'missing',name:'缺失.pdf',recordId:'order-1'}]},{present:pdf});
  await assert.rejects(exportInvoicePackage(store,destination),/缺失.pdf.*附件读取失败/);
  assert.deepEqual(store.reads,['present','missing']);assert.equal(await readFile(destination,'utf8'),'old destination');
  assert.deepEqual((await readdir(folder)).sort(),['keep.zip','unrelated.tmp']);
});

test('真实文件路径分支以文件流导出，成功才替换旧文件，缺失文件同样失败',async t=>{
  const folder=await sandbox(t),source=join(folder,'source.pdf'),destination=join(folder,'existing.zip');
  await writeFile(source,pdf);await writeFile(destination,'old destination');
  const data={records:[baseRecord],invoices:[{id:'1',attachmentId:'source',name:'原始.PDF',recordId:'order-1'}]};
  const store=fakeStore(data);store.attachmentPath=id=>id==='source'?source:join(folder,'missing.pdf');
  store.attachment=()=>{throw new Error('must use file stream, not buffer attachment()');};
  await exportInvoicePackage(store,destination);const bytes=await readFile(destination);
  const zip=await openZip(destination);assert.deepEqual(zip.get('发票/001_304不锈钢螺丝/原始.PDF'),pdf);
  data.invoices.push({id:'2',attachmentId:'missing',name:'缺失.PDF',recordId:'order-1'});
  await assert.rejects(exportInvoicePackage(store,destination),/附件读取失败/);assert.deepEqual(await readFile(destination),bytes);
  assert.ok((await readdir(folder)).every(name=>!name.endsWith('.tmp')));
});

test('目标无法替换时保留目标内容并清理临时文件',async t=>{
  const folder=await sandbox(t),destination=join(folder,'existing-directory');
  await mkdir(destination);await writeFile(join(destination,'keep.txt'),'preserved');
  const store=fakeStore({records:[baseRecord],invoices:[{id:'1',attachmentId:'1',name:'1.pdf',recordId:'order-1'}]},{'1':pdf});
  await assert.rejects(exportInvoicePackage(store,destination));assert.equal(await readFile(join(destination,'keep.txt'),'utf8'),'preserved');
  assert.deepEqual(await readdir(folder),['existing-directory']);
});

test('已核对但金额或日期异常时不悄悄输出错误CSV',()=>{
  for(const override of [{amount:null},{amount:NaN},{amount:-1},{amount:1.005},{purchasedAt:'2026-02-30'}]){
    assert.throws(()=>planInvoiceExport({records:[{...baseRecord,...override}],invoices:[{id:'1',attachmentId:'1',name:'1.pdf',recordId:'order-1'}]}),/无效/);
  }
});
