import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {parseInvoice, findInvoiceMatches} = require('../shared/invoices.cjs');
const record = (id, extra = {}) => ({id, title:'304不锈钢内六角螺丝 M4×20', merchant:'杭州鼎固五金有限公司', amount:128.6, purchasedAt:'2026-10-20', status:'needs_invoice', reviewed:true, invoiceId:null, orderNo:'2398217645086312', ...extra});
const invoice = extra => ({amount:128.6, invoiceNo:'24332000000012345678', issuedAt:'2026-10-23', seller:'杭州鼎固五金有限公司', items:['304不锈钢内六角螺丝'], orderNos:[], warnings:[], ...extra});

test('传统电子普票只取价税合计小写，区分买方卖方并提取多商品', () => {
  const result = parseInvoice(`增值税电子普通发票
发票代码：033002600111 发票号码：12345678
开票日期：2026年10月23日
购买方
名称：杭州买方研发有限公司
纳税人识别号：913300000000000011
货物或应税劳务、服务名称 规格型号 单位 数量 单价 金额 税率 税额
*金属制品*304不锈钢内六角螺丝 M4×20 盒 1 100.00 100.00 13% 13.00
*办公用品*得力复印纸 A4 包 1 13.81 13.81 13% 1.79
合计 ¥113.81 ¥14.79
价 税 合 计（大写）壹佰贰拾捌元陆角整 （小写）￥128.60
销 售 方
名 称：杭州鼎固五金有限公司
纳税人识别号：913300000000000022
备注：订单编号：2398217645086312
开票人：测试开票人`);
  assert.equal(result.amount,128.6); assert.equal(result.invoiceNo,'12345678'); assert.equal(result.issuedAt,'2026-10-23');
  assert.equal(result.seller,'杭州鼎固五金有限公司'); assert.deepEqual(result.items,['304不锈钢内六角螺丝 M4×20','得力复印纸 A4']);
  assert.deepEqual(result.orderNos,['2398217645086312']); assert.deepEqual(result.warnings,[]);
});

test('数电专票双栏购买方和销售方不会串位', () => {
  const result = parseInvoice(`电子发票（增值税专用发票）
发票号码：２４３３２０００００００１２３４５６７８ 开票日期：2026-10-23
购买方信息 销售方信息
名称：测试买方有限公司 名称：北京京东世纪信息技术有限公司
统一社会信用代码/纳税人识别号：913300000000000011 统一社会信用代码/纳税人识别号：911100000000000022
项目名称 规格型号 单位 数量 单价 金额 税率/征收率 税额
*电子设备*罗技无线蓝牙鼠标 只 1 530.09 530.09 13% 68.91
合计 ¥530.09 ¥68.91
价税合计（大写）伍佰玖拾玖元整（小写）¥599.00`);
  assert.equal(result.amount,599); assert.equal(result.invoiceNo,'24332000000012345678');
  assert.equal(result.seller,'北京京东世纪信息技术有限公司'); assert.deepEqual(result.items,['罗技无线蓝牙鼠标']);
  assert.deepEqual(result.orderNos,[]);
});

test('销售方在左的双栏、纵排标签、名称另起一行', () => {
  assert.equal(parseInvoice('销售方信息 购买方信息\n名称：卖方材料有限公司 名称：买方公司\n价税合计¥12.34').seller,'卖方材料有限公司');
  assert.equal(parseInvoice('销\n售\n方\n名称：\n卖方材料有限公司\n纳税人识别号：12345678\n价税合计¥12.34').seller,'卖方材料有限公司');
  assert.equal(parseInvoice('购买方名称：买方公司\n销售方名称：卖方材料有限公司\n价税合计¥12.34').seller,'卖方材料有限公司');
});

test('小写金额允许币种符号拆行、千分位、全角和OCR小数空格', () => {
  for (const input of ['价税合计（小写）\n￥\n1,128.60','价税合计(小写):¥ 1128 . 60','价税合计：１１２８．６０','价税合计\n1128.60']) assert.equal(parseInvoice(input).amount,1128.6,input);
});

test('不把税额、不含税合计、单价或大写金额后随意数字作为总金额', () => {
  for (const input of ['合计 ¥113.81 ¥14.79','金额 ¥113.81\n税额 ¥14.79','价税合计(大写)壹佰元整\n税额13.00','价税合计(小写)无法识别\n税额13.00','价税合计(小写)12345678901234567890','发票号码12345678\n单价128.60','价税合计(小写)113.81 14.79']) assert.equal(parseInvoice(input).amount,null,input);
});

test('多份发票金额冲突与小写读不清时保留人工核对', () => {
  assert.equal(parseInvoice('价税合计(小写)¥128.60\n价税合计(小写)¥100.00').amount,null);
  assert.equal(parseInvoice('价税合计128.60\n(小写)???').amount,null);
  assert.equal(parseInvoice('价税合计(小写)¥128.60\n价税合计(小写)¥128.60').amount,128.6);
});

test('合并PDF的不同票号即使同金额也提示多票，不能只按第一页自动关联', () => {
  const first='发票号码24332000000011111111\n开票日期2026-10-23\n销售方名称：杭州鼎固五金有限公司\n项目名称：304不锈钢内六角螺丝\n价税合计(小写)128.60';
  const second='发票号码24332000000022222222\n开票日期2026-10-23\n销售方名称：其他电子有限公司\n项目名称：罗技无线鼠标\n价税合计(小写)128.60';
  for (const raw of [first+'\n'+second,first+'\n订单号2398217645086312\n'+second]) {
    const parsed=parseInvoice(raw);
    assert.ok(parsed.warnings.some(value=>/多.*发票|不同.*票号|多个.*票号/.test(value)),parsed.warnings.join('；'));
    assert.equal(findInvoiceMatches(parsed,[record('one')]).recordId,null);
  }
});

test('同一发票跨页重复票号不当作不同发票，也不会把发票号码当订单号', () => {
  const page='发票号码24332000000011111111\n开票日期2026-10-23\n销售方名称：杭州鼎固五金有限公司\n项目名称：304不锈钢内六角螺丝\n价税合计(小写)128.60';
  const parsed=parseInvoice(page+'\n'+page);
  assert.equal(parsed.invoiceNo,'24332000000011111111');
  assert.ok(!parsed.warnings.some(value=>/多.*发票|不同.*票号|多个.*票号/.test(value)));
  assert.deepEqual(parsed.orderNos,[]);
  assert.equal(findInvoiceMatches(parsed,[record('one')]).recordId,'one');
});

test('发票号与日期不会被当订单号，订单号仅来自明确标签', () => {
  const result = parseInvoice('发票号码24332000000012345678\n开票日期2026年10月23日\n备注：订单号：2398 2176 4508 6312\n价税合计128.60');
  assert.deepEqual(result.orderNos,['2398217645086312']);
  assert.deepEqual(parseInvoice('发票号码：12345678\n价税合计128.60').orderNos,[]);
  assert.equal(parseInvoice('付款日期2026-10-20\n开票日期2026-02-30').issuedAt,'');
});

test('红字负数保留负号与警告，外币不当人民币', () => {
  for(const raw of ['价税合计(小写)-¥128.60','价税合计(小写)¥-128.60','价税合计(小写)¥−128.60']) { const result=parseInvoice(raw); assert.equal(result.amount,-128.6); assert.ok(result.warnings.some(value=>value.includes('负数'))); }
  assert.ok(parseInvoice('红字发票\n价税合计128.60').warnings.some(value=>value.includes('红字')));
  assert.equal(parseInvoice('价税合计(小写)USD128.60').amount,null);
});

test('同金额加唯一商品或商家证据自动匹配，开票日不要求等于购买日', () => {
  assert.equal(findInvoiceMatches(invoice({seller:''}),[record('one')]).recordId,'one');
  assert.equal(findInvoiceMatches(invoice({items:[],issuedAt:'2026-11-19'}),[record('one')]).recordId,'one');
  assert.equal(findInvoiceMatches(invoice({amount:128.61}),[record('one')]).recordId,null);
});

test('仅金额一致必须人工选择，不把无关不同金额订单加入候选', () => {
  const result=findInvoiceMatches(invoice({seller:'',items:[]}),[record('one'),record('two',{amount:99,orderNo:'other-order'})]);
  assert.equal(result.recordId,null); assert.deepEqual(result.candidates.map(value=>value.recordId),['one']);
  assert.match(result.reason,/仅金额一致/);
});

test('多个同金额订单不会因为一个标题更相似而擅自选择', () => {
  const result=findInvoiceMatches(invoice(),[record('one'),record('two',{title:'办公椅',merchant:'家具公司',orderNo:'other-order'})]);
  assert.equal(result.recordId,null);assert.equal(result.candidates.length,2);assert.match(result.reason,/多个同金额/);
});

test('精确订单号可消除同金额歧义，金额冲突则禁止自动关联', () => {
  const rows=[record('one'),record('two',{orderNo:'00000000000000'})];
  assert.equal(findInvoiceMatches(invoice({orderNos:['2398217645086312']}),rows).recordId,'one');
  const conflict=findInvoiceMatches(invoice({orderNos:['2398217645086312'],amount:129}),rows);
  assert.equal(conflict.recordId,null);assert.match(conflict.reason,/金额不一致/);assert.equal(conflict.candidates.length,1);
});

test('没有总额的明确订单号可匹配，冲突总额和外币仍需人工核对', () => {
  assert.equal(findInvoiceMatches(invoice({amount:null,orderNos:['2398217645086312']}),[record('one')]).recordId,'one');
  for(const warnings of [['识别到不同的价税合计，请核对原发票'],['检测到外币金额，请手动核对人民币报销金额']]) assert.equal(findInvoiceMatches(invoice({amount:null,orderNos:['2398217645086312'],warnings}),[record('one')]).recordId,null);
});

test('多个明确订单号、重复账单号及红字不自动匹配', () => {
  assert.equal(findInvoiceMatches(invoice({orderNos:['2398217645086312','00000000000000']}),[record('one'),record('two',{orderNo:'00000000000000'})]).recordId,null);
  assert.equal(findInvoiceMatches(invoice({orderNos:['2398217645086312']}),[record('one'),record('two')]).recordId,null);
  assert.equal(findInvoiceMatches(invoice({amount:-128.6,orderNos:['2398217645086312']}),[record('one')]).recordId,null);
  assert.equal(findInvoiceMatches(invoice({warnings:['红字发票需核对']}),[record('one')]).recordId,null);
});

test('已报销和已删除订单彻底排除，未核对订单只提供人工候选', () => {
  const result=findInvoiceMatches(invoice(),[record('paid',{status:'reimbursed'}),record('trash',{deletedAt:'2026-10-23'}),record('draft',{reviewed:false})]);
  assert.equal(result.recordId,null);assert.deepEqual(result.candidates.map(value=>value.recordId),['draft']);assert.match(result.candidates[0].reason,/尚未核对/);
});

test('已有发票订单不自动关联，兼容旧版invoiceId与新增发票数组', () => {
  assert.equal(findInvoiceMatches(invoice(),[record('one',{invoiceId:'old-invoice.pdf'})]).recordId,null);
  const result=findInvoiceMatches(invoice(),[record('one')],[{id:'existing',recordId:'one'}]);
  assert.equal(result.recordId,null);assert.match(result.candidates[0].reason,/已有发票/);
  assert.equal(findInvoiceMatches(invoice({id:'self'}),[record('one')],[{id:'self',recordId:'one'}]).recordId,'one');
});

test('泛化商品类别和短平台名称不提供自动关联依据', () => {
  for(const item of ['商品','办公用品','材料','详见清单']) assert.equal(findInvoiceMatches(invoice({items:[item],seller:''}),[record('one',{title:'办公用品材料商品'})]).recordId,null);
  assert.equal(findInvoiceMatches(invoice({items:[],seller:'京东'}),[record('one',{merchant:'京东商城'})]).recordId,null);
});

test('发票解析不改变输入，匹配不改变账单或已有发票', () => {
  const value=Object.freeze(invoice({items:Object.freeze(['304不锈钢内六角螺丝']),orderNos:Object.freeze([]),warnings:Object.freeze([])}));
  const rows=Object.freeze([Object.freeze(record('one'))]);
  assert.equal(findInvoiceMatches(value,rows,Object.freeze([])).recordId,'one');
});
