const STATUSES = ['needs_invoice', 'ready', 'submitted', 'reimbursed'];
const STATUS_LABELS = { needs_invoice: '待开发票', ready: '待提交', submitted: '已提交', reimbursed: '已到账' };
const CATEGORIES = ['办公用品', '数码设备', '交通出行', '餐饮招待', '差旅住宿', '软件服务', '其他支出'];
const DEFAULT_SETTINGS = { invoiceDays: 7, reimbursementDays: 30, reminderDays: 3, reminderTime: '09:00', notifications: true, closeToTray: true, startAtLogin: false, companyName: '', taxNumber: '' };
function localDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split('-').map(Number);
  const date = new Date(y,m-1,d);
  return y >= 1990 && y <= 2100 && date.getFullYear()===y && date.getMonth()===m-1 && date.getDate()===d;
}
function addDays(value, days) {
  if (!validDate(value)) throw new Error('日期格式无效');
  const [y,m,d] = value.split('-').map(Number);
  const date = new Date(y,m-1,d+days);
  return localDate(date);
}
function daysBetween(from,to) {
  const utc = v => {const [y,m,d] = v.split('-').map(Number);return Date.UTC(y,m-1,d);};
  return Math.round((utc(to)-utc(from))/86400000);
}
function dueDate(record) { return record.status === 'needs_invoice' ? record.invoiceDueDate : record.reimbursementDueDate; }
function reminderRecords(records,settings,today=localDate()) {
  return records.filter(r => !r.deletedAt && r.status !== 'reimbursed' && validDate(dueDate(r)) && daysBetween(today,dueDate(r)) <= settings.reminderDays)
    .sort((a,b) => dueDate(a).localeCompare(dueDate(b)));
}
function cents(value) {return Number.isFinite(value) ? Math.round(value*100) : 0;}
function validateEditable(input) {
  if (!input || typeof input !== 'object') throw new Error('账单内容无效');
  const title = String(input.title || '').trim();
  if (!title || title.length > 200) throw new Error('请输入 1～200 字的商品或消费名称');
  const amount = input.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 99999999 || Math.abs(amount*100-Math.round(amount*100)) > 0.00001) throw new Error('金额须为 0～99,999,999 元，最多两位小数');
  if (!validDate(input.purchasedAt)) throw new Error('请选择正确的购买日期');
  const purchasedTime=String(input.purchasedTime||'');
  if(purchasedTime&&!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(purchasedTime))throw new Error('购买时间格式无效');
  if (!validDate(input.invoiceDueDate) || !validDate(input.reimbursementDueDate)) throw new Error('请设置正确的开票和报销提醒日期');
  if (!STATUSES.includes(input.status)) throw new Error('报销状态无效');
  if (!CATEGORIES.includes(input.category)) throw new Error('支出分类无效');
  const text = (key,max) => {const value=String(input[key]||'').trim();if(value.length>max)throw new Error('文本内容过长');return value;};
  return {title,amount:cents(amount)/100,purchasedAt:input.purchasedAt,purchasedTime:purchasedTime.length===5?purchasedTime+':00':purchasedTime,invoiceDueDate:input.invoiceDueDate,reimbursementDueDate:input.reimbursementDueDate,status:input.status,category:input.category,merchant:text('merchant',200),orderNo:text('orderNo',100),note:text('note',2000),reviewed:true};
}
function validateSettings(input) {
  const output = {...DEFAULT_SETTINGS};
  for(const [key,min,max] of [['invoiceDays',0,365],['reimbursementDays',0,730],['reminderDays',0,30]]) {
    const value = Number(input[key]);
    if(!Number.isInteger(value)||value<min||value>max)throw new Error('提醒天数超出允许范围');
    output[key]=value;
  }
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.reminderTime))throw new Error('提醒时间无效');
  output.reminderTime=input.reminderTime;
  for(const key of ['notifications','closeToTray','startAtLogin']) {
    if(typeof input[key]!=='boolean')throw new Error('设置格式无效');
    output[key]=input[key];
  }
  output.companyName=String(input.companyName||'').trim().slice(0,200);
  output.taxNumber=String(input.taxNumber||'').trim().slice(0,50);
  return output;
}
function csv(records) {
  const cell = value => {
    let text=String(value??'');
    if(/^\s*[=+\-@\t\r]/.test(text))text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
  };
  const rows=[['商品 / 消费','商家','金额（CNY）','购买日期','购买时间','分类','状态','开票提醒日','报销提醒日','订单号','已核对','发票附件','备注']];
  for(const r of records)rows.push([r.title,r.merchant,r.amount==null?'':r.amount.toFixed(2),r.purchasedAt,r.purchasedTime||'',r.category,STATUS_LABELS[r.status],r.invoiceDueDate,r.reimbursementDueDate,r.orderNo,r.reviewed?'是':'否',r.invoiceName||'',r.note]);
  return '\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n');
}
module.exports={STATUSES,STATUS_LABELS,CATEGORIES,DEFAULT_SETTINGS,localDate,validDate,addDays,daysBetween,dueDate,reminderRecords,cents,validateEditable,validateSettings,csv};
