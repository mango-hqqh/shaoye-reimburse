import type { Receipt, Settings, Status } from './types';
export const STATUS_LABELS:Record<Status,string>={needs_invoice:'待开发票',ready:'待提交',submitted:'已提交',reimbursed:'已到账'};
export const CATEGORIES=['办公用品','数码设备','交通出行','餐饮招待','差旅住宿','软件服务','其他支出'];
export const STEPS:Status[]=['needs_invoice','ready','submitted','reimbursed'];
export function today(date=new Date()){return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');}
export function addDays(value:string,days:number){const [y,m,d]=value.split('-').map(Number);return today(new Date(y,m-1,d+days));}
export function dayDiff(value:string,from=today()){const utc=(v:string)=>{const [y,m,d]=v.split('-').map(Number);return Date.UTC(y,m-1,d);};return Math.round((utc(value)-utc(from))/86400000);}
export function dueDate(record:Receipt){return record.status==='needs_invoice'?record.invoiceDueDate:record.reimbursementDueDate;}
export function reminders(records:Receipt[],settings:Settings){return records.filter(r=>!r.deletedAt&&r.status!=='reimbursed'&&dayDiff(dueDate(r))<=settings.reminderDays).sort((a,b)=>dueDate(a).localeCompare(dueDate(b)));}
export function amount(value:number|null){return value===null?'待核对':new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(value);}
export function sum(records:Receipt[]){return records.reduce((value,r)=>value+(r.reviewed&&r.amount!==null?Math.round(r.amount*100):0),0)/100;}
export function dueLabel(record:Receipt){const days=dayDiff(dueDate(record));return days<0?'已逾期 '+Math.abs(days)+' 天':days===0?'今天到期':days===1?'明天到期':days+' 天后到期';}
export function nextLabel(record:Receipt){return !record.reviewed?'核对账单':record.status==='needs_invoice'?'标记已开票':record.status==='ready'?'标记已提交':record.status==='submitted'?'确认已到账':'查看详情';}
export const api=window.shaoye;
