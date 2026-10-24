import {_electron as electron} from '@playwright/test';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {resolve,join,basename} from 'node:path';
import {mkdir,readFile,writeFile,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const require=createRequire(import.meta.url),yauzl=require('yauzl');
const root=process.cwd(),results=resolve('test-results'),fixtures=resolve('tests/fixtures');
const fixtureNames=['invoice-text.pdf','invoice-scan.pdf','invoice-original.jpg'];
const defaults={amount:128.6,seller:'鼎固五金旗舰店',item:'304不锈钢内六角螺丝',orderNo:'2398217645086312',issuedAt:'2026-10-23',purchasedAt:'2026-10-21'};
let metadata={};
try{metadata=JSON.parse(await readFile(join(fixtures,'invoices.expected.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const expected={...defaults,...metadata};
const originals=new Map(await Promise.all(fixtureNames.map(async name=>[name,await readFile(join(fixtures,name))])));
await mkdir(results,{recursive:true});
const folder=await mkdtemp(join(results,'desktop-invoices-'));
const executable=process.env.SHAOYE_EXECUTABLE||require('electron');
const env={...process.env,SHAOYE_TEST:'1',SHAOYE_DATA_DIR:folder};
delete env.ELECTRON_RUN_AS_NODE;delete env.SHAOYE_DEV_URL;
const errors=[],network=[];
const report={passed:false,syntheticFixtures:true,executable,dataDir:folder,steps:[],errors,network};
const launch=()=>electron.launch({executablePath:executable,args:process.env.SHAOYE_EXECUTABLE?[]:[root],env,timeout:60000});
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const note='E2E 回归：逗号, 引号"保留"\n第二行备注';
let app,page;

function passed(message){report.steps.push(message);console.log('PASS: '+message);}
function observe(window){
  window.on('pageerror',error=>errors.push(error.message));
  window.on('request',request=>{if(/^https?:/.test(request.url()))network.push(request.url());});
  window.setDefaultTimeout(30000);
}
const snapshot=()=>page.evaluate(()=>window.shaoye.snapshot());
const invoiceRow=name=>page.locator('.invoice-row').filter({has:page.locator('.invoice-file-heading strong').filter({hasText:name})});
const saveDialog=file=>app.evaluate(({dialog},path)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:path});},file);

function unzip(file){
  return new Promise((resolveZip,reject)=>yauzl.open(file,{lazyEntries:true,strictFileNames:true},(error,zip)=>{
    if(error){reject(error);return;}
    const entries=new Map();let ended=false;
    const fail=error=>{zip.close();reject(error);};
    zip.on('error',fail);zip.on('end',()=>{ended=true;});zip.on('close',()=>{if(ended)resolveZip(entries);});
    zip.on('entry',entry=>zip.openReadStream(entry,(error,stream)=>{
      if(error){fail(error);return;}
      const chunks=[];
      stream.on('data',chunk=>chunks.push(chunk));stream.on('error',fail);
      stream.on('end',()=>{
        if(entries.has(entry.fileName)){fail(new Error('Duplicate ZIP entry: '+entry.fileName));return;}
        entries.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();
      });
    }));
    zip.readEntry();
  }));
}

function csvRows(bytes){
  assert.deepEqual([...bytes.subarray(0,3)],[0xef,0xbb,0xbf],'CSV must contain UTF-8 BOM');
  const text=bytes.toString('utf8').replace(/^\ufeff/,'');
  const rows=[];let row=[],cell='',quoted=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='"'){
      if(quoted&&text[index+1]==='"'){cell+='"';index++;}else quoted=!quoted;
    }else if(char===','&&!quoted){row.push(cell);cell='';}
    else if((char==='\r'||char==='\n')&&!quoted){
      if(char==='\r'&&text[index+1]==='\n')index++;
      row.push(cell);rows.push(row);row=[];cell='';
    }else cell+=char;
  }
  assert.equal(quoted,false,'CSV quotes must balance');
  if(row.length||cell){row.push(cell);rows.push(row);}
  assert.ok(rows.every(row=>row.length===5),'Every CSV row must have exactly five columns');
  assert.deepEqual(rows[0],['商品 / 消费','商家','金额（CNY）','购买日期','备注']);
  return rows;
}

async function verifyPackage(file,{pendingOnly=false}={}){
  const entries=await unzip(file),rows=csvRows(entries.get('报销清单.csv'));
  assert.ok(entries.has('导出说明.txt'));
  assert.equal(rows.length,pendingOnly?1:2,'Multiple invoices must not duplicate the order amount');
  if(!pendingOnly){
    const date=expected.purchasedAt.split('-').map(Number).join('/');
    assert.deepEqual(rows[1],[expected.item,expected.seller,expected.amount.toFixed(2),date,note]);
    assert.notEqual(rows[1][3],expected.issuedAt.split('-').map(Number).join('/'),'Invoice date must not replace purchase date');
  }
  const attachmentEntries=[...entries].filter(([name])=>!['报销清单.csv','导出说明.txt'].includes(name));
  assert.equal(attachmentEntries.length,pendingOnly?1:3);
  for(const [name,bytes] of attachmentEntries){
    const originalName=basename(name);
    assert.ok(originals.has(originalName),'Unexpected ZIP file: '+name);
    assert.deepEqual(bytes,originals.get(originalName),'Original invoice bytes must remain unchanged: '+originalName);
    if(originalName==='invoice-original.jpg')assert.match(name,/^待确认发票\//);
    else assert.match(name,/^发票\/001_/);
  }
  if(pendingOnly)assert.ok(attachmentEntries.every(([name])=>name.startsWith('待确认发票/')));
  return {entries:[...entries.keys()],csv:rows,sha256:sha256(await readFile(file))};
}

async function verifyStoredOriginals(state){
  for(const invoice of state.invoices.filter(invoice=>!invoice.deletedAt)){
    const original=originals.get(invoice.name);
    assert.ok(original,'Unexpected invoice name '+invoice.name);
    const actual=await readFile(join(state.dataDir,'attachments',invoice.attachmentId));
    assert.deepEqual(actual,original,'Stored attachment was converted or changed: '+invoice.name);
    assert.equal(invoice.hash,sha256(original));
    assert.equal(invoice.attachmentId.split('.').at(-1),invoice.name.endsWith('.jpg')?'jpg':'pdf');
  }
}

try{
  app=await launch();page=await app.firstWindow();observe(page);
  await page.waitForSelector('.stats-grid');
  assert.equal((await snapshot()).ocrReady,true,'Offline OCR resources must be available');
  const record=await page.evaluate(input=>window.shaoye.saveReceipt(input),{
    title:expected.item,merchant:expected.seller,amount:expected.amount,purchasedAt:expected.purchasedAt,purchasedTime:'14:30:28',
    category:'其他支出',status:'needs_invoice',invoiceDueDate:'2026-10-28',reimbursementDueDate:'2026-11-20',orderNo:expected.orderNo,note
  });
  assert.equal(record.reviewed,true);
  await page.locator('.nav-item').filter({hasText:'发票管理'}).click();
  await page.getByLabel('选择发票文件',{exact:true}).setInputFiles(fixtureNames.map(name=>join(fixtures,name)));
  await page.waitForFunction(()=>document.querySelector('.invoice-batch-heading')?.textContent?.includes('本次导入完成'),null,{timeout:300000});
  let state=await snapshot();
  report.initialInvoices=state.invoices;
  await writeFile(join(results,'invoice-import-result.json'),JSON.stringify(state.invoices,null,2),'utf8');
  assert.equal(state.invoices.length,3,await page.locator('.invoice-batch').innerText());
  const byName=name=>state.invoices.find(invoice=>invoice.name===name);
  const textInvoice=byName('invoice-text.pdf'),scanInvoice=byName('invoice-scan.pdf'),jpegInvoice=byName('invoice-original.jpg');
  for(const invoice of [textInvoice,scanInvoice,jpegInvoice]){
    assert.ok(invoice);assert.equal(invoice.amount,expected.amount,invoice.name+' amount');assert.equal(invoice.seller,expected.seller,invoice.name+' seller');
    assert.ok(invoice.items.some(item=>item.includes(expected.item)),invoice.name+' product: '+JSON.stringify(invoice.items));
    assert.ok(invoice.orderNos.includes(expected.orderNo),invoice.name+' order number');assert.equal(invoice.issuedAt,expected.issuedAt,invoice.name+' issued date');
    assert.match(invoice.invoiceNo,/^\d{20}$/,invoice.name+' digital invoice number');
    assert.ok(invoice.rawText.length>50,invoice.name+' must actually be read/OCRed');
    assert.ok(!invoice.warnings.some(warning=>/识别未完成|读取超时/.test(warning)),invoice.name+' must not silently fall back to an unread attachment');
  }
  if(expected.textInvoiceNo)assert.equal(textInvoice.invoiceNo,expected.textInvoiceNo);
  if(expected.scanInvoiceNo)assert.equal(scanInvoice.invoiceNo,expected.scanInvoiceNo);
  assert.notEqual(textInvoice.invoiceNo,scanInvoice.invoiceNo);
  assert.equal(textInvoice.recordId,record.id,'Text PDF should automatically match the unique reviewed order');
  assert.equal(scanInvoice.recordId,null,'An order already holding an invoice requires manual confirmation');
  assert.equal(jpegInvoice.recordId,null);
  assert.equal(state.records[0].status,'ready');assert.equal(state.records[0].purchasedAt,expected.purchasedAt);
  await verifyStoredOriginals(state);
  await page.screenshot({path:join(results,'invoices-library.png'),fullPage:true});
  passed('UI batch import reads text PDF, OCRs scanned PDF/JPEG, matches text PDF and preserves all original formats');

  await page.getByLabel('选择发票文件',{exact:true}).setInputFiles(join(fixtures,'invoice-text.pdf'));
  await page.waitForFunction(()=>{const heading=document.querySelector('.invoice-batch-heading')?.textContent||'';return heading.includes('本次导入完成')&&/1\s*\/\s*1/.test(heading);});
  assert.match(await page.locator('.invoice-import-counts').innerText(),/重复\s*1/);
  assert.equal((await snapshot()).invoices.length,3);
  const duplicate=await page.evaluate(bytes=>window.shaoye.importInvoice({bytes:new Uint8Array(bytes),name:'duplicate.pdf',requestId:'invoice-duplicate'}),Array.from(originals.get('invoice-text.pdf')));
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.invoice.id,textInvoice.id);assert.equal((await snapshot()).invoices.length,3);
  passed('UI and API reject duplicate content without adding a fourth invoice');

  await invoiceRow('invoice-scan.pdf').getByRole('button',{name:'关联订单',exact:true}).click();
  await page.getByLabel('选择关联订单 invoice-scan.pdf',{exact:true}).selectOption(record.id);
  await page.screenshot({path:join(results,'invoices-association.png'),fullPage:true});
  await invoiceRow('invoice-scan.pdf').getByRole('button',{name:'确认关联',exact:true}).click();
  await page.waitForSelector('.invoice-match-panel',{state:'hidden'});
  state=await snapshot();
  assert.equal(state.invoices.filter(invoice=>invoice.recordId===record.id&&!invoice.deletedAt).length,2);
  assert.equal(state.invoices.find(invoice=>invoice.id===textInvoice.id).recordId,record.id,'First invoice association must be retained');
  assert.equal(state.invoices.find(invoice=>invoice.id===jpegInvoice.id).recordId,null);
  passed('UI manual association retains both invoices for one order and leaves the JPEG pending');

  await page.evaluate(id=>window.shaoye.setStatus(id,'needs_invoice'),record.id);
  await invoiceRow('invoice-text.pdf').locator('.invoice-order-link').click();
  await page.waitForSelector('.editor');
  await page.locator('.editor textarea').fill(note+'（未保存修改）');
  await page.locator('.invoice-attachment input[type="file"]').setInputFiles(join(fixtures,'invoice-text.pdf'));
  await page.waitForFunction(()=>document.querySelector('.editor .status-steps button.selected')?.textContent?.includes('待提交'));
  assert.equal(await page.locator('.editor textarea').inputValue(),note+'（未保存修改）');
  await page.getByRole('button',{name:'确认并保存',exact:true}).click();
  await page.waitForSelector('.editor',{state:'hidden'});
  state=await snapshot();assert.equal(state.records[0].status,'ready');assert.equal(state.records[0].note,note+'（未保存修改）');
  await page.evaluate(input=>window.shaoye.saveReceipt(input),{...state.records[0],note});
  passed('Adding an attachment in order details preserves unsaved edits and saves the updated invoice state');

  // Only native dialogs/external viewers are replaced in this isolated process.
  // Parsing, OCR, matching, storage, backups and ZIP generation remain real.
  await app.evaluate(({shell})=>{globalThis.__invoiceSmokeOpened=[];shell.openPath=async path=>{globalThis.__invoiceSmokeOpened.push(path);return '';};});
  await invoiceRow('invoice-scan.pdf').getByRole('button',{name:'打开原文件 invoice-scan.pdf',exact:true}).click();
  const opened=await app.evaluate(()=>globalThis.__invoiceSmokeOpened);
  assert.equal(opened.length,1);assert.deepEqual(await readFile(opened[0]),originals.get('invoice-scan.pdf'));
  passed('Open-original button passes the untouched PDF to the native shell');

  const zipPath=join(folder,'报销材料.zip');
  await saveDialog(zipPath);
  await page.locator('.invoice-export-strip').getByRole('button',{name:/导出报销材料 ZIP/}).click();
  await page.getByText(/报销材料已导出：3 份发票、1 笔订单/).waitFor();
  report.package=await verifyPackage(zipPath);
  assert.equal((await snapshot()).records[0].status,'ready','Export must not change actual reimbursement state');
  passed('UI ZIP export contains original files and a five-column CSV; two invoices produce one amount and purchase date');

  await page.evaluate(id=>window.shaoye.setStatus(id,'reimbursed'),record.id);
  const paidZip=join(folder,'已报销排除.zip');await saveDialog(paidZip);
  assert.deepEqual(await page.evaluate(()=>window.shaoye.exportInvoicePackage()),{exported:true,invoiceCount:1,recordCount:0,unmatchedCount:1});
  report.paidPackage=await verifyPackage(paidZip,{pendingOnly:true});
  assert.equal((await snapshot()).records[0].status,'reimbursed');
  await assert.rejects(()=>page.evaluate(id=>window.shaoye.matchInvoice(id,null),textInvoice.id),/已报销/);
  await page.evaluate(id=>window.shaoye.setStatus(id,'ready'),record.id);
  await page.evaluate(id=>window.shaoye.trash(id),record.id);
  const trashZip=join(folder,'回收站排除.zip');await saveDialog(trashZip);
  assert.deepEqual(await page.evaluate(()=>window.shaoye.exportInvoicePackage()),{exported:true,invoiceCount:1,recordCount:0,unmatchedCount:1});
  await verifyPackage(trashZip,{pendingOnly:true});
  await page.evaluate(id=>window.shaoye.restore(id),record.id);
  passed('Paid and trashed orders are excluded from ZIP exports while unmatched originals remain available');

  const backupPath=join(folder,'invoices-backup.json');await saveDialog(backupPath);
  assert.equal(await page.evaluate(()=>window.shaoye.backup()),true);
  const backup=JSON.parse(await readFile(backupPath,'utf8'));
  assert.equal(backup.data.invoices.length,3);assert.equal(Object.keys(backup.attachments).length,3);
  for(const invoice of backup.data.invoices)assert.deepEqual(Buffer.from(backup.attachments[invoice.attachmentId],'base64'),originals.get(invoice.name));
  const beforeRestore=await snapshot();
  await page.evaluate(id=>window.shaoye.removeInvoice(id),scanInvoice.id);
  await page.evaluate(id=>window.shaoye.trash(id),record.id);
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});dialog.showMessageBox=async()=>({response:1});},backupPath);
  assert.equal(await page.evaluate(()=>window.shaoye.restoreBackup()),1);
  state=await snapshot();
  assert.equal(state.records.length,1);assert.equal(state.records[0].deletedAt,null);assert.equal(state.records[0].status,'ready');
  assert.equal(state.invoices.filter(invoice=>!invoice.deletedAt).length,3);
  assert.equal(state.invoices.filter(invoice=>invoice.recordId===record.id).length,2);
  for(const invoice of state.invoices)assert.notEqual(invoice.attachmentId,beforeRestore.invoices.find(old=>old.id===invoice.id).attachmentId,'Restore must create new internal filenames');
  await verifyStoredOriginals(state);
  passed('Backup/restore preserves invoice originals and many-to-one associations with newly mapped attachment IDs');

  await app.close();app=null;
  app=await launch();page=await app.firstWindow();observe(page);await page.waitForSelector('.stats-grid');
  state=await snapshot();
  assert.equal(state.records.length,1);assert.equal(state.records[0].id,record.id);assert.equal(state.records[0].reviewed,true);
  assert.equal(state.records[0].amount,expected.amount);assert.equal(state.records[0].purchasedAt,expected.purchasedAt);assert.equal(state.records[0].status,'ready');
  assert.equal(state.invoices.length,3);assert.equal(state.invoices.filter(invoice=>invoice.recordId===record.id&&!invoice.deletedAt).length,2);
  assert.equal(state.invoices.find(invoice=>invoice.id===jpegInvoice.id).recordId,null);
  await verifyStoredOriginals(state);
  await page.locator('.nav-item').filter({hasText:'发票管理'}).click();
  await page.locator('.invoice-row').first().waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,760));
  await page.waitForTimeout(200);
  await page.screenshot({path:join(results,'invoices-compact.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Invoice manager must fit a 1100px desktop window');
  const restoredZip=join(folder,'恢复后报销材料.zip');await saveDialog(restoredZip);
  assert.deepEqual(await page.evaluate(()=>window.shaoye.exportInvoicePackage()),{exported:true,invoiceCount:3,recordCount:1,unmatchedCount:1});
  report.restoredPackage=await verifyPackage(restoredZip);
  assert.equal(errors.length,0,errors.join('\n'));assert.equal(network.length,0,'Desktop invoice workflows must remain offline');
  report.finalInvoices=state.invoices;report.passed=true;
  passed('Restart retains invoices and associations; restored ZIP is correct; 1100px layout has no overflow or renderer errors');
}catch(error){
  report.error={message:error.message,stack:error.stack};
  if(page){
    report.failureSnapshot=await snapshot().catch(()=>null);
    await page.screenshot({path:join(results,'invoices-failure.png'),fullPage:true}).catch(()=>{});
  }
  throw error;
}finally{
  await writeFile(join(results,'smoke-invoices-report.json'),JSON.stringify(report,null,2),'utf8');
  if(app)await app.close();
}
