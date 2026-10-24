const {app,BrowserWindow,ipcMain,dialog,Menu,Tray,nativeImage,Notification,shell,powerMonitor}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomUUID,createHash}=require('node:crypto');
const {Store}=require('./store.cjs');
const {Ocr}=require('./ocr.cjs');
const {InvoiceService,ensureInvoice}=require('./invoice-service.cjs');
const {exportInvoicePackage,planInvoiceExport}=require('./invoice-export.cjs');
const {makeBackup,restoreBackup}=require('./backup.cjs');
const {parseReceipt}=require('../shared/parser.cjs');
const {STATUSES,localDate,validateEditable,validateSettings,reminderRecords,csv}=require('../shared/domain.cjs');
const testMode=process.env.SHAOYE_TEST==='1';
const dataDir=process.env.SHAOYE_DATA_DIR||path.join(app.getPath('appData'),'ShaoyeReimburse');
app.setPath('userData',dataDir);
app.setAppUserModelId('com.shaoye.reimburse');
let window,store,ocr,invoiceService,tray,quitting=false,reminderTimer,importQueue=Promise.resolve(),notifying=false;
const notifications=new Set();
const iconPath=path.join(__dirname,'../assets/icon.png');
const send=(channel,value)=>{if(window&&!window.isDestroyed())window.webContents.send('shaoye:'+channel,value);};
const changed=()=>send('changed');
const ensureRecord=(data,id)=>{const record=data.records.find(r=>r.id===id);if(!record)throw new Error('账单不存在');return record;};
function inputBytes(input){
  if(!input||!(input.bytes instanceof Uint8Array)&&!Array.isArray(input.bytes))throw new Error('文件内容无效');
  if(!input.bytes.length||input.bytes.length>20*1024*1024)throw new Error('每个文件请保持在 20 MB 以内');
  return Buffer.from(input.bytes);
}
function decodeImage(bytes){
  const image=nativeImage.createFromBuffer(bytes);
  const {width,height}=image.getSize();
  if(image.isEmpty()||width<20||height<20)throw new Error('无法读取图片，请选择 PNG、JPG、WEBP 或 BMP 图片');
  if(width*height>40000000||width>24000||height>24000)throw new Error('图片尺寸过大，请先裁剪到订单内容');
  return image;
}
function ocrBuffer(image){
  // The OCR worker keeps screenshot text at readable size and tiles long images.
  return image.toPNG();
}
function bind(name,handler){
  ipcMain.handle('shaoye:'+name,async(event,...args)=>{
    try{
      if(!window||event.sender.id!==window.webContents.id||event.senderFrame!==window.webContents.mainFrame)throw new Error('请求来源无效');
      return {ok:true,data:await handler(...args)};
    }catch(error){return {ok:false,error:error?.message||'操作失败，请重试'};}
  });
}
function showWindow(page){
  if(!window||window.isDestroyed())createWindow();
  window.show();if(window.isMinimized())window.restore();window.focus();
  if(page)send('navigate',page);
}
async function showNotification(title,body){
  if(!Notification.isSupported())throw new Error('此系统暂不支持桌面通知');
  const notification=new Notification({title,body,icon:iconPath});
  notifications.add(notification);
  notification.on('click',()=>showWindow('reminders'));
  notification.on('close',()=>notifications.delete(notification));
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{notifications.delete(notification);reject(new Error('系统尚未确认通知已显示，请检查 Windows 通知设置'));},10000);
    notification.once('show',()=>{clearTimeout(timer);resolve();});
    notification.once('failed',(_event,error)=>{clearTimeout(timer);notifications.delete(notification);reject(new Error(error||'Windows 未能显示通知'));});
    notification.show();
  });
}
async function checkReminders(){
  if(!store||notifying||testMode)return;
  const {settings,records,lastNotification}=store.snapshot();
  const now=new Date(),today=localDate(now),time=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
  if(!settings.notifications||time<settings.reminderTime||lastNotification===today)return;
  const due=reminderRecords(records,settings,today);
  if(!due.length)return;
  notifying=true;
  try{
    await showNotification('少爷，该收回自己的钱啦',due.length+' 笔消费需要处理：'+due.slice(0,2).map(r=>r.title).join('、')+'。点击查看提醒。');
    await store.update(data=>{data.lastNotification=today;});
  }catch(error){console.error('Reminder:',error.message);}
  finally{notifying=false;}
}
async function extract(buffer,id){
  try{
    const result=await ocr.recognize(buffer,id);
    const parsed=parseReceipt(result.text,store.data.settings);
    parsed.warnings.push(...(result.warnings||[]));
    if(result.confidence<55)parsed.warnings.push('图片较难识别，请仔细核对');
    return {...parsed,confidence:result.confidence,ocrEngine:result.engine||'tesseract'};
  }catch(error){
    const parsed=parseReceipt('',store.data.settings);
    return {...parsed,confidence:0,warnings:['识别未完成：'+error.message,'原图已保存，可以手动填写或重新识别']};
  }
}
function registerHandlers(){
  bind('snapshot',()=>({...store.snapshot(),dataDir,recovered:store.recovered,packaged:app.isPackaged,version:app.getVersion(),ocrReady:ocr.isReady()}));
  bind('importImage',input=>{
    // 排队包含去重和保存操作，避免并发导入同一图片生成重复账单。
    const job=importQueue.then(async()=>{
      const bytes=inputBytes(input);
      const hash=createHash('sha256').update(bytes).digest('hex');
      const previous=store.data.records.find(r=>r.sourceHash===hash&&!r.deletedAt);
      if(previous)return {record:previous,duplicate:true};
      const image=decodeImage(bytes);
      const id=randomUUID();
      const imageId=await store.putAttachment(image.toPNG());
      const extracted=await extract(ocrBuffer(image),String(input.requestId||id));
      const stamp=new Date().toISOString();
      const record={...extracted,id,imageId,sourceHash:hash,sourceName:String(input.name||'图片').slice(0,255),status:'needs_invoice',reviewed:false,reimbursedAt:null,invoiceId:null,invoiceName:'',note:'',createdAt:stamp,updatedAt:stamp,deletedAt:null};
      await store.update(data=>{data.records.unshift(record);});
      changed();return {record,duplicate:false};
    });
    importQueue=job.catch(()=>{});return job;
  });
  bind('retryOcr',async id=>{
    const before=ensureRecord(store.data,id);
    if(!before.imageId)throw new Error('此账单没有原始图片');
    const result=await extract(ocrBuffer(decodeImage(await store.attachment(before.imageId))),id);
    await store.update(data=>{
      const record=ensureRecord(data,id);
      if(record.updatedAt!==before.updatedAt)throw new Error('账单已被修改，请重新打开后再识别');
      // Re-recognition only updates extracted fields; keep the user's workflow and reminders.
      const {invoiceDueDate,reimbursementDueDate}=record;
      Object.assign(record,result,{invoiceDueDate,reimbursementDueDate,reviewed:false,updatedAt:new Date().toISOString()});
    });
    changed();return ensureRecord(store.data,id);
  });
  bind('saveReceipt',async input=>{
    const fields=validateEditable(input);
    const stamp=new Date().toISOString();
    const result=await store.update(data=>{
      if(input.id){
        const record=ensureRecord(data,input.id);
        if(record.deletedAt)throw new Error('请先从回收站恢复账单');
        const reimbursedAt=fields.status==='reimbursed'?(record.reimbursedAt||stamp):null;
        Object.assign(record,fields,{updatedAt:stamp,warnings:[],reimbursedAt});return record;
      }
      const record={...fields,reimbursedAt:fields.status==='reimbursed'?stamp:null,id:randomUUID(),imageId:null,invoiceId:null,invoiceName:'',sourceHash:'',sourceName:'手动记账',rawText:'',confidence:100,warnings:[],deletedAt:null,createdAt:stamp,updatedAt:stamp};
      data.records.unshift(record);return record;
    });changed();return result;
  });
  bind('setStatus',async(id,status)=>{
    if(!STATUSES.includes(status))throw new Error('状态无效');
    await store.update(data=>{const record=ensureRecord(data,id);if(record.deletedAt)throw new Error('账单已移入回收站');if(!record.reviewed)throw new Error('请先核对并保存识别结果');record.status=status;record.updatedAt=new Date().toISOString();record.reimbursedAt=status==='reimbursed'?(record.reimbursedAt||record.updatedAt):null;});
    changed();
  });
  bind('trash',async id=>{await store.update(data=>{ensureRecord(data,id).deletedAt=new Date().toISOString();});changed();});
  bind('restore',async id=>{await store.update(data=>{ensureRecord(data,id).deletedAt=null;});changed();});
  bind('image',async id=>{
    const record=ensureRecord(store.data,id);
    if(!record.imageId)return null;
    return 'data:image/png;base64,'+(await store.attachment(record.imageId)).toString('base64');
  });
  bind('attachInvoice',async(id,input)=>{
    ensureRecord(store.data,id);
    const bytes=inputBytes(input);
    await invoiceService.import(bytes,input.name,id);
    changed();return ensureRecord(store.data,id);
  });
  bind('importInvoice',async input=>{const result=await invoiceService.import(inputBytes(input),input.name,null,input.requestId);changed();return result;});
  bind('invoiceCandidates',id=>invoiceService.candidates(id));
  bind('matchInvoice',async(id,recordId)=>{const invoice=await invoiceService.match(id,recordId);changed();return invoice;});
  bind('removeInvoice',async id=>{await invoiceService.remove(id);changed();});
  bind('openInvoiceFile',async id=>{
    const invoice=ensureInvoice(store.data,id);
    const error=await shell.openPath(store.attachmentPath(invoice.attachmentId));if(error)throw new Error(error);
  });
  bind('exportInvoicePackage',async()=>{
    planInvoiceExport(store.snapshot());
    const choice=await dialog.showSaveDialog(window,{title:'导出待报销发票和清单',defaultPath:'报销材料-'+localDate()+'.zip',filters:[{name:'ZIP 报销材料',extensions:['zip']}]});
    if(choice.canceled)return {exported:false,invoiceCount:0,recordCount:0,unmatchedCount:0};
    const counts=await exportInvoicePackage(store,choice.filePath);return {exported:true,...counts};
  });
  bind('openInvoice',async id=>{
    const record=ensureRecord(store.data,id);
    if(!record.invoiceId)throw new Error('暂无发票附件');
    const error=await shell.openPath(store.attachmentPath(record.invoiceId));if(error)throw new Error(error);
  });
  bind('updateSettings',async input=>{
    const settings=validateSettings(input);
    if(settings.startAtLogin!==store.data.settings.startAtLogin){
      if(!app.isPackaged&&settings.startAtLogin)throw new Error('请安装应用后开启开机启动');
      if(!testMode)app.setLoginItemSettings({openAtLogin:settings.startAtLogin,args:['--hidden']});
    }
    await store.update(data=>{data.settings=settings;});changed();return settings;
  });
  bind('exportCsv',async ids=>{
    if(!Array.isArray(ids)||!ids.every(id=>typeof id==='string'))throw new Error('导出范围无效');
    const selected=new Set(ids);
    const records=store.data.records.filter(r=>selected.has(r.id)&&!r.deletedAt);
    if(!records.length)throw new Error('当前没有可导出的账单');
    const result=await dialog.showSaveDialog(window,{title:'导出当前账单清单',defaultPath:'报销清单-'+localDate()+'.csv',filters:[{name:'Excel 可打开的 CSV',extensions:['csv']}]});
    if(result.canceled)return false;
    await fs.promises.writeFile(result.filePath,csv(records),'utf8');return true;
  });
  bind('backup',async()=>{
    const result=await dialog.showSaveDialog(window,{title:'备份账本和全部附件',defaultPath:'报销备份-'+localDate()+'.json',filters:[{name:'账本备份',extensions:['json']}]});
    if(result.canceled)return false;
    const content=await makeBackup(store);await fs.promises.writeFile(result.filePath,content);return true;
  });
  bind('restoreBackup',async()=>{
    const choice=await dialog.showOpenDialog(window,{title:'选择账本备份',properties:['openFile'],filters:[{name:'账本备份',extensions:['json']}]});
    if(choice.canceled)return null;
    const file=choice.filePaths[0];
    if((await fs.promises.stat(file)).size>300*1024*1024)throw new Error('备份文件超过 300 MB');
    const raw=JSON.parse(await fs.promises.readFile(file,'utf8'));
    require('./backup.cjs').checkBackup(raw);
    const confirm=await dialog.showMessageBox(window,{type:'question',title:'恢复备份',message:'将用备份中的 '+raw.data.records.length+' 笔账单替换当前账本。',detail:'当前账本会在数据目录中自动备份。原有图片会保留。开机启动设置保持当前选择。',buttons:['取消','恢复备份'],defaultId:0,cancelId:0});
    if(confirm.response!==1)return null;
    const automatic=await makeBackup(store);
    await fs.promises.writeFile(path.join(dataDir,'before-restore-'+Date.now()+'.json'),automatic);
    raw.data.settings.startAtLogin=store.data.settings.startAtLogin;
    const count=await restoreBackup(store,raw);changed();return count;
  });
  bind('openDataFolder',async()=>{const error=await shell.openPath(dataDir);if(error)throw new Error(error);});
  bind('notifyTest',async()=>{await showNotification('提醒已经准备好','少爷，别忘了开发票。到期账单会在这里提醒你。');return true;});
  bind('windowCommand',command=>{if(command==='minimize')window.minimize();else if(command==='maximize')window.isMaximized()?window.unmaximize():window.maximize();else if(command==='close')window.close();else if(command==='quit'){quitting=true;app.quit();}});
}
function createWindow(){
  window=new BrowserWindow({width:1440,height:940,minWidth:1080,minHeight:720,backgroundColor:'#f6f7f9',title:'少爷今天报销了吗',icon:iconPath,show:false,titleBarStyle:'hidden',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false,offscreen:testMode,backgroundThrottling:!testMode}});
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window.webContents.session.setPermissionCheckHandler(()=>false);
  window.on('close',event=>{
    if(!quitting&&store.data.settings.closeToTray&&tray&&!testMode){event.preventDefault();window.hide();}
  });
  window.once('ready-to-show',()=>{if(!process.argv.includes('--hidden')&&!testMode)window.show();});
  const devUrl=!app.isPackaged&&process.env.SHAOYE_DEV_URL;
  if(devUrl){
    if(devUrl!=='http://127.0.0.1:5173')throw new Error('开发服务器地址无效');
    window.loadURL(devUrl);
  }else window.loadFile(path.join(__dirname,'../dist/index.html'));
  if(process.env.SHAOYE_DEVTOOLS==='1')window.webContents.openDevTools({mode:'detach'});
}
const locked=app.requestSingleInstanceLock();
if(!locked){app.quit();}
else {
  app.on('second-instance',()=>showWindow());
  app.whenReady().then(()=>{
    store=new Store(dataDir);
    const langPath=app.isPackaged?path.join(process.resourcesPath,'tessdata'):path.join(__dirname,'../assets/tessdata');
    ocr=new Ocr(langPath,(id,message)=>send('progress',{id,status:message.status,progress:Math.max(0,Math.min(1,message.progress||0))}));
    invoiceService=new InvoiceService(store,ocr,decodeImage);
    registerHandlers();Menu.setApplicationMenu(null);createWindow();
    if(!testMode){
      tray=new Tray(nativeImage.createFromPath(iconPath).resize({width:32,height:32}));
      tray.setToolTip('少爷今天报销了吗 · 正在守候报销提醒');
      tray.setContextMenu(Menu.buildFromTemplate([{label:'打开报销助手',click:()=>showWindow()},{label:'查看待办提醒',click:()=>showWindow('reminders')},{type:'separator'},{label:'退出应用',click:()=>{quitting=true;app.quit();}}]));
      tray.on('double-click',()=>showWindow());
    }
    reminderTimer=setInterval(checkReminders,60000);
    setTimeout(checkReminders,5000);
    powerMonitor.on('resume',checkReminders);
  }).catch(error=>{dialog.showErrorBox('应用启动失败',error.message);quitting=true;app.quit();});
  app.on('before-quit',()=>{quitting=true;clearInterval(reminderTimer);ocr?.stop().catch(()=>{});});
  app.on('window-all-closed',()=>{if(testMode||!tray||!store?.data.settings.closeToTray)app.quit();});
  app.on('activate',()=>showWindow());
}
