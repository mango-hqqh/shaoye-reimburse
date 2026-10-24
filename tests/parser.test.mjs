import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {parseReceipt,parseAmount}=require('../shared/parser.cjs');

// Manually constructed text fixtures model common shopping-order layouts.
// They validate field extraction, not OCR accuracy on customer screenshots.
test('淘宝布局：实付款不被同一行的运费与优惠替换',()=>{
  const r=parseReceipt('订单详情\n交易成功\n张三 138****1234\n浙江省杭州市西湖区文一路100号\n罗技官方旗舰店 >\n罗技无线鼠标 静音办公鼠标\n便携蓝牙双模连接\n黑色;标准版\n¥159.00 ×1\n商品总价¥159.00 优惠¥30.00\n实付款 ¥129.00(含运费¥0.00) 已优惠¥30.00\n订单编号:1234567890123456789 复制\n付款时间:2026-10-2014:30:00\n联系卖家 查看物流 申请售后');
  assert.equal(r.title,'罗技无线鼠标静音办公鼠标 便携蓝牙双模连接');
  assert.equal(r.merchant,'罗技官方旗舰店');assert.equal(r.amount,129);
  assert.equal(r.orderNo,'1234567890123456789');assert.equal(r.purchasedAt,'2026-10-20');assert.equal(r.purchasedTime,'14:30:00');
});
test('京东布局：多行标题、收货信息、规格、商品价和订单实付',()=>{
  const r=parseReceipt('订单详情\n已完成\n李四 139****5678\n北京市海淀区中关村大街10号\n得力京东自营官方旗舰店\n得力(deli)A4复印纸打印纸\n70g办公用纸500张\n规格:A4 70g;5包\n¥119.00\n×1\n申请售后\n商品金额 ¥119.00\n运费 ¥0.00\n优惠券 -¥20.00\n实付金额:¥99.00\n下单时间:2026-10-20 12:00:00\n支付时间:2026-10-20 12:01:23');
  assert.equal(r.title,'得力(deli)A4复印纸打印纸 70g办公用纸500张');assert.equal(r.merchant,'得力京东自营官方旗舰店');
  assert.equal(r.amount,99);assert.equal(r.purchasedTime,'12:01:23');
});
test('金额按最近标签关联，支持一行内多个金额标签和数量',()=>{
  for(const text of ['商品总价¥699.00 运费¥6.00 优惠¥100.00 实付款¥605.00','共2件 实付款 ¥605.00 优惠¥100.00 运费¥6.00','实付金额:605.00 订单号:1234567890123456','原价999.00 实付605.00 运费6.00','¥605.00 实付款']){
    assert.equal(parseReceipt(text).amount,605,text);
  }
});
test('实付优先于总计和商品合计；外币仍不自动作为人民币',()=>{
  assert.equal(parseReceipt('订单总额 ¥300.00\n实付款 ¥280.00\n合计 ¥300.00').amount,280);
  assert.equal(parseReceipt('合计 ¥120.00\n实付款 HK$100.00').amount,null);
});
test('标签和人民币小数拆行、空格、全角字符',()=>{
  for(const text of ['实 付 款\n￥\n128\n.80','实付款 ￥128\n.80','实付款 ￥128.\n80','实付款：￥１２８．８０','实付款:¥ 128 . 80','实付款(含运费)¥128.80']){
    assert.equal(parseReceipt(text).amount,128.8,text);
  }
});
test('无明确实付时不把两件商品价格中的一个当成整单金额',()=>{
  const r=parseReceipt('罗技官方旗舰店\n罗技无线鼠标\n¥99.00\n×1\n罗技无线键盘\n¥199.00\n×1');
  assert.equal(r.amount,null);assert.ok(r.warnings.some(w=>w.includes('多个可能的金额')));
  assert.ok(r.warnings.some(w=>w.includes('多个商品')));
});
test('多商品保留整单实付并提示手动拆分，不生成虚构分摊价格',()=>{
  const r=parseReceipt('京东自营店\n无线办公鼠标 ¥99.00\n黑色\n×1\n机械办公键盘 ¥199.00\n白色\n×1\n实付款 ¥298.00');
  assert.equal(r.amount,298);assert.match(r.title,/等多件商品$/);assert.ok(r.warnings.some(w=>w.includes('手动拆分')));
});
test('多个不同订单的实付款不自动选最后一笔或最大一笔',()=>{
  const r=parseReceipt('商品:办公键盘\n实付款¥99.00\n商品:无线鼠标\n实付款¥39.00');
  assert.equal(r.amount,null);assert.ok(r.warnings.some(w=>w.includes('多个可能的金额')));
});
test('同一笔实付重复出现时不误判金额冲突',()=>{
  assert.equal(parseReceipt('实付款 ¥129.00\n实付款:129.00').amount,129);
});
test('长订单号、数量、时间、优惠不能被截取成金额',()=>{
  for(const text of ['实付款:订单号12345678901234567890','订单号12345678901234567890\n优惠¥30.00','实付款 共2件\n支付时间2026-10-20 14:30:00','实付款 12345678901234567890','商品总价 ¥299.00\n优惠 ¥30.00\n运费 ¥6.00']){
    assert.equal(parseReceipt(text).amount,null,text);
  }
});
test('合法商品名中的电话、食品、会员字样不被导航过滤',()=>{
  assert.match(parseReceipt('小米京东自营店\n小米儿童电话手表\n蓝色\n¥299.00\n实付款¥299.00').title,/电话手表/);
  assert.equal(parseReceipt('商品:办公软件会员订阅\n实付款¥99.00').title,'办公软件会员订阅');
  assert.equal(parseReceipt('商品:休闲食品礼盒\n实付款¥99.00').title,'休闲食品礼盒');
  assert.equal(parseReceipt('商品:电话手表\n实付款¥99.00').title,'电话手表');
  assert.equal(parseReceipt('商品:鼠标\n实付款¥99.00').title,'鼠标');
});
test('没有商品信息时不使用导航、收货人、规格或金额作为标题',()=>{
  const r=parseReceipt('订单详情\n已完成\n王五 138****3333\n上海市浦东新区世纪大道100号\n颜色:黑色\n联系客服 查看物流\n实付款 ¥29.00\n支付时间2026-10-20');
  assert.equal(r.title,'待核对的消费');assert.ok(r.warnings.includes('未找到商品名称'));
});
test('紧贴日期的小时与分秒不丢失，不将日期后四位误当日期',()=>{
  for(const text of ['支付时间:2026-10-2014:30:59','支付时间:2026年10月20日14:30:59','支付时间:2026-10-20 14 : 30 : 59']){
    const r=parseReceipt(text);assert.equal(r.purchasedAt,'2026-10-20');assert.equal(r.purchasedTime,'14:30:59');
  }
  assert.equal(parseReceipt('订单编号:2026-10-2014').purchasedAt,'');
});
test('订单号保守合并数字间OCR空格，不吞后续字段',()=>{
  assert.equal(parseReceipt('订单编号:1234 5678 9012 3456 复制\n实付款¥99.00').orderNo,'1234567890123456');
  assert.equal(parseReceipt('订单号:AB-12345678\n实付款¥99.00').orderNo,'AB-12345678');
  assert.equal(parseReceipt('订单号:123456 USD\n实付款¥99.00').orderNo,'');
});
test('独立 parseAmount 接口兼容，并处理整行实付多金额',()=>{
  assert.equal(parseAmount(['实付款 ¥99.00 运费 ¥6.00 优惠 ¥20.00']).amount,99);
});
test('合成淘宝截图经OCR后的文字：图片噪声与规格不能拆成多个商品',()=>{
  const text='14:36 5G\n订单详情\n交易成功\n感谢您的购买，欢迎再次光临\n收货信息\n测试用户138****0000\n浙江省杭州市西湖区测试路88号\n鼎固五金旗舰店>\n304不锈钢内六角螺丝\nM4×20100颗装\n颜色分类：本色规格：M4×20\n￥148.60 x1\n七天无理由退货·退货运费险\n申请售后\n商品总价 ￥148.60\n运费 ¥0.00\n店铺优惠 -¥20.00\n实付款 ￥128.60\n支付方式：支付宝\n订单信息\n订单编号 2398217645086312 复制\n创建时间 2026-10-21 14:28:06\n付款时间 2026-10-21 14:30:28\n成交时间 2026-10-23 09:16:05\n合成回归测试截图·非真实订单';
  for(const raw of [text,text.replace('螺丝\n','螺丝\n0OO\n').replace('2026-10-21 14:30','2026-10-2114:30')]){
    const r=parseReceipt(raw);
    assert.equal(r.title,'304不锈钢内六角螺丝 M4×20100颗装');assert.equal(r.amount,128.6);assert.equal(r.merchant,'鼎固五金旗舰店');
    assert.equal(r.purchasedAt,'2026-10-21');assert.equal(r.purchasedTime,'14:30:28');assert.deepEqual(r.warnings,[]);
  }
});
test('实付读不清时不退回原价；跨行优惠和商品金额不当实付',()=>{
  for(const raw of ['商品:测试鼠标\n¥299.00\n实付款:???','订单总额¥299.00\n实付款:???','商品金额\n¥299.00\n优惠\n¥30.00','优惠\n¥\n30.00']){
    assert.equal(parseReceipt(raw).amount,null,raw);
  }
});
test('商场导航和第二家店名不会进入商品名称',()=>{
  const r=parseReceipt('京东商城\n办公自营店\n办公胶水套装\n¥29.00\n数码旗舰店\n蓝牙办公鼠标\n¥99.00\n实付款¥128.00');
  assert.equal(r.merchant,'办公自营店');assert.ok(!r.title.includes('旗舰店'));assert.ok(r.warnings.some(w=>w.includes('多个商品')));
});
test('合成京东截图经OCR后的文字：京豆抵扣、物流和发票不是第二件商品',()=>{
  const text='10:24 5G\n订单详情\n已完成\n您的订单已完成，感谢您在京东购物\n收货信息\n测试用户138****0000\n浙江省杭州市西湖区测试路88号\n罗技京东自营旗舰店\n罗技（Logitech）无线蓝牙鼠标\nMXMaster3S办公静音\n颜色：石墨黑版本：标准版\n￥699.00 x1\n京东物流·7天价保·免费上门退换\n申请售后\n商品金额 ￥699.00\n运费 ¥0.00\n优惠券 -¥100.00\n京豆 -¥0.00\n实付金额 ￥599.00\n在线支付·微信支付\n订单信息\n订单编号 284398276510 复制\n下单时间 2026-10-22 10:16:03\n支付时间 2026-10-22 10:18:45\n完成时间 2026-10-23 08:52:10\n发票信息 电子普通发票\n合成回归测试截图·非真实订单';
  for(const raw of [text,text.replaceAll('2026-10-22 10:','2026-10-2210:').replace(' x1',' ×1').replace('在线支付·','在线支付：'),text.replace('2026-10-23 08:','2026-10-2308:')]){
    const r=parseReceipt(raw);
    assert.equal(r.title,'罗技(Logitech)无线蓝牙鼠标 MXMaster3S办公静音');assert.equal(r.amount,599);
    assert.equal(r.merchant,'罗技京东自营旗舰店');assert.equal(r.orderNo,'284398276510');
    assert.equal(r.purchasedAt,'2026-10-22');assert.equal(r.purchasedTime,'10:18:45');assert.deepEqual(r.warnings,[]);
  }
});
test('京豆、积分和礼金的价格不作为商品或订单金额',()=>{
  for(const raw of ['京豆 ¥10.00','京豆\n¥10.00','积分抵扣 ¥10.00','购物金\n¥20.00'])assert.equal(parseReceipt(raw).amount,null,raw);
  assert.equal(parseReceipt('实付款¥99.00 京豆¥10.00 优惠券¥20.00').amount,99);
});
test('购买日期仅使用当前或紧邻标签，支付标签不能串到发货退款日期',()=>{
  for(const raw of ['付款时间:未显示\n发货日期:2026-10-22','支付时间\n退款日期:2026-10-23','支付时间:暂无 发货时间:2026-10-22','预计送达日期:2026-10-24','退款成功时间:2026-10-24'])assert.equal(parseReceipt(raw).purchasedAt,'',raw);
  assert.equal(parseReceipt('下单日期:2026-10-20\n支付时间:无\n发货时间:2026-10-22').purchasedAt,'2026-10-20');
  assert.equal(parseReceipt('下单日期:2026-10-20\n支付时间:\n2026-10-21 10:18:45\n退款日期:2026-10-23').purchasedAt,'2026-10-21');
  const inline=parseReceipt('下单时间2026-10-20 支付时间2026-10-21 10:18:45 发货时间2026-10-22');
  assert.equal(inline.purchasedAt,'2026-10-21');assert.equal(inline.purchasedTime,'10:18:45');
});
