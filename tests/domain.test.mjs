import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {parseReceipt}=require('../shared/parser.cjs');
const {validDate,addDays,reminderRecords,validateEditable,validateSettings,DEFAULT_SETTINGS,csv}=require('../shared/domain.cjs');
const sample={title:'无线鼠标',merchant:'京东',amount:299,purchasedAt:'2026-10-20',category:'数码设备',status:'needs_invoice',invoiceDueDate:'2026-10-27',reimbursementDueDate:'2026-11-19',orderNo:'202610220001',note:''};
test('实付金额优先于商品原价、优惠、运费、订单号',()=>{
  const result=parseReceipt('商家：京东自营店\n商品：罗技无线鼠标\n订单号：202610220001\n商品金额：￥329.00\n优惠金额：￥30.00\n运费：￥6.00\n实付金额：￥299.00\n支付时间：2026-10-20 14:30:00',DEFAULT_SETTINGS,'2026-10-22');
  assert.equal(result.amount,299);assert.equal(result.title,'罗技无线鼠标');assert.equal(result.merchant,'京东自营店');assert.equal(result.purchasedAt,'2026-10-20');assert.equal(result.orderNo,'202610220001');assert.equal(result.category,'数码设备');assert.equal(result.invoiceDueDate,'2026-10-27');
});
test('OCR 中文空格、千位分隔符、跨行价格',()=>{
  const r=parseReceipt('商 品：办公桌\n实 付 金 额\n¥ 1,299.50\n付 款 时 间：2026年10月21日');
  assert.equal(r.amount,1299.5);assert.equal(r.purchasedAt,'2026-10-21');
});
test('支付日期优先于发货日期和页面里较早的下单日期',()=>{
  const r=parseReceipt('下单时间 2026-10-01\n发货时间 2026-10-08\n支付时间 2026-10-03\n预计送达 2026-10-10');assert.equal(r.purchasedAt,'2026-10-03');
});
test('未知金额和日期不凭空填充；外币不作为人民币统计',()=>{
  const r=parseReceipt('商品：测试鼠标\n订单号：12345678901234\n优惠：30.00');assert.equal(r.amount,null);assert.equal(r.purchasedAt,'');assert.ok(r.warnings.length>=2);
  assert.equal(parseReceipt('商品：Mouse\nTOTAL PAID USD $29.00').amount,null);
});
test('取消、未支付订单保留风险提醒',()=>{assert.ok(parseReceipt('订单已取消\n商品：鼠标\n实付金额 ¥29.00').warnings.some(w=>w.includes('取消')));});
test('日历正确处理闰年、月末和无效日期',()=>{
  assert.equal(validDate('2026-02-30'),false);assert.equal(validDate('2024-02-29'),true);assert.equal(addDays('2026-12-31',1),'2027-01-01');assert.equal(addDays('2026-10-31',7),'2026-11-07');
});
test('提醒包含逾期、当天、提前窗口，排除回收站和已到账',()=>{
  const records=[{...sample,id:'a',invoiceDueDate:'2026-10-01'},{...sample,id:'b',invoiceDueDate:'2026-10-22'},{...sample,id:'c',invoiceDueDate:'2026-10-25'},{...sample,id:'d',invoiceDueDate:'2026-10-26'},{...sample,id:'e',deletedAt:'2026-10-01',invoiceDueDate:'2026-10-01'},{...sample,id:'f',status:'reimbursed',invoiceDueDate:'2026-10-01'}];
  assert.deepEqual(reminderRecords(records,DEFAULT_SETTINGS,'2026-10-22').map(r=>r.id),['a','b','c']);
});
test('已开票、已提交切换到报销日期提醒',()=>{assert.equal(reminderRecords([{...sample,status:'submitted',invoiceDueDate:'2026-10-01',reimbursementDueDate:'2026-11-19'}],DEFAULT_SETTINGS,'2026-10-22').length,0);});
test('金额精度、必填日期和状态在主进程验证',()=>{
  assert.equal(validateEditable(sample).reviewed,true);
  for(const bad of [{amount:null},{amount:NaN},{amount:-1},{amount:1.001},{amount:1e12},{purchasedAt:'2026-02-30'},{status:'fake'},{title:'  '}])assert.throws(()=>validateEditable({...sample,...bad}));
  assert.equal(validateEditable({...sample,amount:0}).amount,0);
});
test('设置边界和时间格式',()=>{assert.deepEqual(validateSettings(DEFAULT_SETTINGS),DEFAULT_SETTINGS);assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,reminderTime:'99:00'}));assert.throws(()=>validateSettings({...DEFAULT_SETTINGS,reminderDays:-1}));});
test('CSV 保护公式注入，保留双引号、换行和 UTF-8 BOM',()=>{
  const output=csv([{...sample,title:'=HYPERLINK("bad")',note:'一行\n第二行',reviewed:true}]);
  assert.ok(output.startsWith('\ufeff'));assert.ok(output.includes("'=HYPERLINK"));assert.ok(output.includes('""bad""'));assert.ok(output.includes('一行\n第二行'));assert.ok(output.includes('299.00'));
});

test('购买时间保留秒数，识别分号不丢商品名，外币符号不当人民币',()=>{const r=parseReceipt('商品; 罗技无线鼠标\n支付时间:2026-10-20 14:30:59\n实付金额:299.00');assert.equal(r.purchasedTime,'14:30:59');assert.equal(r.title,'罗技无线鼠标');assert.equal(parseReceipt('TOTAL $29.00').amount,null);assert.throws(()=>validateEditable({...sample,purchasedTime:'99:00'}));});

test('商品与商家字段分成两行时仍能提取',()=>{const r=parseReceipt('商品名称\n无线办公键盘\n商家\n数码自营店\n实付金额:99.90\n购买日期:2026-10-20');assert.equal(r.title,'无线办公键盘');assert.equal(r.merchant,'数码自营店');});
