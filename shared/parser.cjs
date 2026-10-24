const {validDate, localDate, addDays, DEFAULT_SETTINGS} = require('./domain.cjs');

function normalize(text) {
  return String(text).normalize('NFKC').replace(/\r/g,'').replace(/￥/g,'¥')
    .replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g,'')
    .replace(/[ \t]+/g,' ').trim();
}

function parsePurchaseDate(text) {
  const datePattern=/(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})(?:\s*日)?(?:[ T]*([01]?\d|2[0-3])\s*:\s*([0-5]\d)(?:\s*:\s*([0-5]\d))?)?(?!\d)/g;
  const dateLabel=/支付(?:时间|日期)|付款(?:时间|日期)|交易(?:时间|日期)|消费(?:时间|日期)|下单(?:时间|日期)|订单(?:时间|日期)|购买(?:时间|日期)|创建(?:时间|日期)|开票日期|完成(?:时间|日期)|成交(?:时间|日期)|退款(?:成功)?(?:时间|日期)?|退货(?:时间|日期)?|发货(?:时间|日期)?|送达(?:时间|日期)?|预计(?:送达)?(?:时间|日期)?|截止(?:时间|日期)?|日期/g;
  const scoreDate=(index)=>{
    const lineStart=text.lastIndexOf('\n',index-1)+1;
    let prefix=text.slice(lineStart,index);
    // Only a standalone label on the immediately preceding row may carry over.
    // A payment label elsewhere must never promote a shipping/refund date.
    if(!prefix.trim()&&lineStart>0)prefix=text.slice(text.lastIndexOf('\n',lineStart-2)+1,lineStart-1);
    const labels=[...prefix.matchAll(dateLabel)],last=labels.at(-1);
    if(!last||!/^\s*[:;]?\s*$/.test(prefix.slice(last.index+last[0].length)))return 0;
    if(/退款|退货|发货|送达|预计|截止/.test(last[0]))return -100;
    if(/支付|付款|交易|消费/.test(last[0]))return 100;
    if(/完成|成交/.test(last[0]))return 20;
    return 60;
  };
  const hits=[...text.matchAll(datePattern)].map(m=>({
    value: m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'),
    score:scoreDate(m.index),
    time: m[4]?m[4].padStart(2,'0')+':'+m[5]+':'+(m[6]||'00'):''
  })).filter(m=>validDate(m.value));
  const ranked=hits.map((hit,index)=>({...hit,index}));
  ranked.sort((a,b)=>b.score-a.score||a.index-b.index);
  return ranked[0]?.score>=0 ? {date:ranked[0].value,time:ranked[0].time} : {date:'',time:''};
}
function parseDate(text){return parsePurchaseDate(text).date;}

// A price belongs to its closest field, not to every label elsewhere on the row.
// OCR frequently places paid amount, shipping, and discount on the same row.
const MONEY_LABEL=/订单实付(?:款|金额)?|实付款?(?:金额)?|实际(?:支付|付款)(?:金额)?|支付金额|付款金额|合计支付|金额实付|价税合计(?:\(小写\))?|AMOUNT PAID|TOTAL PAID|应付(?:金额)?|订单总额|订单金额|交易金额|消费金额|总计|合计|TOTAL|商品(?:总价|总额|金额)|原价|优惠(?:券|金额)?|已优惠|折扣|折后价|立减|红包|运费(?:险)?|配送费|节省|退款(?:金额)?|返现|积分(?:抵扣)?|京豆(?:抵扣)?|京贴|购物金|礼金|余额|单价|定金|尾款/gi;
const PAID_LABEL=/订单实付|实付|实际支付|实际付款|支付金额|付款金额|合计支付|金额实付|价税合计|AMOUNT PAID|TOTAL PAID/i;
const TOTAL_LABEL=/^(?:订单总额|订单金额|交易金额|消费金额|总计|合计|TOTAL)$/i;
const BLOCKING_FIELD=/订单(?:编号|号码|号)|交易(?:单号|编号)|流水号|手机号|税号|时间|日期|收货|地址|电话|数量/;
const CURRENCY=/[¥]|元|RMB|CNY/i;

function moneyTokens(source) {
  // Require complete tokens: long order numbers cannot become a valid 8-digit price.
  const pattern=/(?<![\dA-Za-z.,])(?:¥\s*|(?:RMB|CNY)\s*)?(\d{1,3}(?:\s*,\s*\d{3})+(?:\s*[.。]\s*\d{1,2})?|\d{1,8}(?:\s*[.。]\s*\d{1,2})?)(?:\s*元)?(?![\dA-Za-z.,])/gi;
  return [...source.matchAll(pattern)].flatMap(match=>{
    const before=source.slice(0,match.index), after=source.slice(match.index+match[0].length);
    if(/[-/年.]\s*$/.test(before)||/^\s*[-/:年月日件个张包套台笔种人次]/i.test(after)||/[x×]\s*$/i.test(before))return [];
    const value=Number(match[1].replace(/[\s,]/g,'').replace('。','.'));
    if(!Number.isFinite(value)||value>99999999)return [];
    return [{value,index:match.index,end:match.index+match[0].length,raw:match[0],currency:CURRENCY.test(match[0])}];
  });
}

function parseAmount(inputLines) {
  const lines=inputLines.map(line=>normalize(line).replace(/\((?:含运费|含配送费|含税)\)/g,''));
  const foreign=lines.some(l=>/(?:USD|HKD|HK\$|US\$|美元|港币|港元|EUR|欧元|GBP|英镑|JPY|日元|[$€£])/i.test(l));
  if(foreign)return {amount:null,foreign:true};
  const candidates=[];
  const labeledLines=new Set();
  let highestLabelScore=0;
  for(let i=0;i<lines.length;i++){
    const line=lines[i],labels=[...line.matchAll(MONEY_LABEL)];
    if(!labels.length)continue;
    labeledLines.add(i);
    for(let j=0;j<labels.length;j++){
      const label=labels[j], score=PAID_LABEL.test(label[0])?120:TOTAL_LABEL.test(label[0])?80:0;
      highestLabelScore=Math.max(highestLabelScore,score);
      if(!score){
        if(j===labels.length-1&&/^[\s:;()\[\]¥-]*$/.test(line.slice(label.index+label[0].length))){
          for(let offset=1;offset<=3&&i+offset<lines.length;offset++){
            if(!/^(?:¥|RMB|CNY)?\s*(?:[\d, .。]+\s*(?:元)?|¥)$/i.test(lines[i+offset]))break;
            labeledLines.add(i+offset);
          }
        }
        continue;
      }
      let segment=line.slice(label.index+label[0].length,labels[j+1]?.index??line.length);
      const blockedAt=segment.search(BLOCKING_FIELD);
      if(blockedAt>=0)segment=segment.slice(0,blockedAt);
      if(/\d\s*[.。]\s*$/.test(segment)&&/^\s*\d{1,2}\s*(?:元)?$/.test(lines[i+1]||'')){
        segment+=' '+lines[i+1];labeledLines.add(i+1);
      }else if(/\d\s*$/.test(segment)&&/^\s*[.。]\s*\d{1,2}\s*(?:元)?$/.test(lines[i+1]||'')){
        segment+=' '+lines[i+1];labeledLines.add(i+1);
      }
      let tokens=moneyTokens(segment);
      // Standalone labels and currency symbols can be recognized as separate rows.
      if(!tokens.length && /^[\s:;()\[\]¥]*$/.test(segment)){
        for(let offset=1;offset<=3&&i+offset<lines.length;offset++){
          const next=lines[i+offset];
          if(!/^(?:¥|RMB|CNY)?\s*(?:[\d, .。]+\s*(?:元)?|¥)$/i.test(next))break;
          segment+=' '+next;labeledLines.add(i+offset);
          tokens=moneyTokens(segment);
          // A decimal fraction may be on the following baseline in a large price.
          if(tokens.length && /^\s*[.。]\s*\d{1,2}\s*(?:元)?$/.test(lines[i+offset+1]||'')){
            segment+=' '+lines[i+offset+1];labeledLines.add(i+offset+1);tokens=moneyTokens(segment);
          }
          if(tokens.length)break;
        }
      }
      // Some layouts put the label to the right of its amount, e.g. ¥129.00 实付款.
      if(!tokens.length && j===0){
        const prefix=line.slice(0,label.index);
        if(/^(?:\s|[:;()])*[¥\d]/.test(prefix)&&!BLOCKING_FIELD.test(prefix))tokens=moneyTokens(prefix);
      }
      const currencyTokens=tokens.filter(t=>t.currency);
      const usable=currencyTokens.length?currencyTokens:tokens;
      // Multiple bare numbers in one label region are ambiguous; do not pick by size.
      if(usable.length===1)candidates.push({value:usable[0].value,score,line:i});
      else if(usable.length>1)candidates.push({value:null,score,line:i});
    }
  }
  if(candidates.length){
    const bestScore=Math.max(...candidates.map(c=>c.score));
    if(highestLabelScore>bestScore)return {amount:null,foreign:false};
    const top=candidates.filter(c=>c.score===bestScore), values=[...new Set(top.map(c=>c.value))];
    if(values.length!==1||values[0]===null)return {amount:null,foreign:false,ambiguous:true};
    return {amount:values[0],foreign:false};
  }
  if(highestLabelScore)return {amount:null,foreign:false};
  const fallback=[];
  for(let i=0;i<lines.length;i++){
    if(labeledLines.has(i)||BLOCKING_FIELD.test(lines[i])||/优惠|折扣|立减|红包|运费|退款|原价|积分|余额|定金|尾款/.test(lines[i]))continue;
    fallback.push(...moneyTokens(lines[i]).filter(t=>t.currency));
  }
  const values=[...new Set(fallback.map(t=>t.value))];
  return {amount:values.length===1?values[0]:null,foreign:false,ambiguous:values.length>1};
}

const TITLE_LABEL=/^(?:商品(?:名称|信息|说明)?|交易商品|产品(?:名称)?|消费项目|项目名称|品名)(?:\s*[:;]\s*|\s+|$)/;
const MERCHANT_LABEL=/^(?:商家(?:名称)?|店铺(?:名称)?|收款方|销售方(?:名称)?|商户(?:名称)?|酒店(?:名称)?)(?:\s*[:;]\s*|\s+|$)/;
const SHOP_SUFFIX=/(?:旗舰店|专卖店|专营店|自营店|官方店|官方旗舰店|直营店|便利店|有限公司|咖啡店|酒店|商城)$/;
const MONEY_ROW=/^(?:[¥]|(?:RMB|CNY)\s*\d|[\d,.]+\s*元|[x×]\s*\d|\d[\d,.]*\s*$)/i;
const NAVIGATION=/^(?:订单详情|交易详情|交易账单|订单信息|订单服务|商品信息|费用明细|价格明细|支付信息|付款信息|配送信息|物流信息|发票信息|购买须知|购物车|我的淘宝|我的京东|淘宝|京东商城|京东|天猫|拼多多|支付宝|微信支付|返回|更多|复制|展开|收起|查看全部|查看详情|查看更多|详情|首页|评价|追评|追加评价|再来一单|再次购买|加入购物车|删除订单|延长收货|确认收货|查看物流|申请售后|退换售后|退款售后|联系卖家|联系商家|联系店铺|联系商户|联系客户|联系京东|联系客服|店铺会员|店铺首页|关注店铺|进入店铺|申请开票|申请发票|查看发票|我要开票|开发票|发票|买家留言|售后服务|商品评价|商品快照|运费险|价保|价格保护|七天无理由|7天无理由|极速退款|假一赔四|支持退换)(?:$|[\s:;>›〈〉《》|·/])/;
const STATUS=/^(?:交易成功|支付成功|付款成功|交易完成|订单完成|订单已完成|已完成|已签收|已收货|已发货|卖家已发货|商家已发货|等待买家付款|等待买家收货|等待卖家发货|买家已付款|待付款|待支付|待发货|待收货|待评价|订单已取消|已取消|已关闭|交易关闭|退款成功|订单已关闭|您的订单|感谢您|感谢你|包裹已|订单已签收)/;
const METADATA=/^(?:订单(?:编号|号码|号)|交易(?:单号|编号)|商户单号|流水号|支付方式|付款方式|下单时间|付款时间|支付时间|交易时间|创建时间|完成时间|购买时间|购买日期|开票日期|日期(?=[:;\s\d]|$)|发货时间|预计送达|配送方式|收货(?:人|地址|信息)?|地址(?=[:;\s]|$)|电话(?=[:;\s\d]|$)|手机号码|买家|卖家备注|税号|税率|税额|买家实付|共\s*\d+\s*[件种]|售后|服务保障|服务说明|配送服务|发票抬头|开票状态)(?:\s*[:;]?)/;
const SPEC=/^(?:规格|颜色分类|颜色|款式|包装规格|大小|尺码|尺寸|型号|版本|套餐|容量|重量|数量|商品属性|已选|选择)(?:\s*[:;]|$)|^(?:黑色|白色|灰色|银色|蓝色|红色|粉色|绿色|紫色|金色|银灰色|经典黑|标准版|升级版|官方标配|默认规格|均码)(?:$|[;\s/|·,])/;
const ADJUSTMENT_ROW=/^(?:店铺|平台|跨店|商品|促销|活动|京豆|礼金)?(?:优惠|折扣|立减|红包|运费|返现|抵扣|退款|折合|减免)|^(?:京豆|京贴|购物金|礼金|积分)(?:[:;\s+¥-]|$)/;
const SERVICE_ROW=/^(?:七天无理由|7天无理由|支持7天|支持七天|退货包运费|退货运费险|极速退款|满\d+减|预计可得|赠送积分|在线支付|电子支付|发票信息)|^(?:京东|顺丰|菜鸟)?物流(?:[·,.:;\s]|$)/;

function cleanMerchant(value){
  return value.replace(/\s*[>›〉»]+.*$/,'').replace(/(?:进入店铺|联系卖家|联系商家|联系客服|关注店铺|交易成功|已完成|自营标识).*$/,'').trim();
}
function cleanTitle(value){
  return value.replace(/^\[(?:京东自营|自营|天猫|淘宝)\]\s*/,'')
    .replace(/\s*¥\s*[\d,. ]+(?:元)?(?:\s*[x×]\s*\d+)?\s*$/i,'')
    .replace(/(?:^|\s)[x×]\s*\d+\s*$/i,'').trim();
}
function isNameLine(line,merchant,labeled=false){
  if(!line||line===merchant||cleanMerchant(line)===merchant||(!labeled&&SHOP_SUFFIX.test(cleanMerchant(line)))||MONEY_ROW.test(line)||NAVIGATION.test(line)||STATUS.test(line)||METADATA.test(line)||SPEC.test(line)||MERCHANT_LABEL.test(line)||ADJUSTMENT_ROW.test(line)||SERVICE_ROW.test(line))return false;
  if([...line.matchAll(MONEY_LABEL)].some(m=>m.index===0))return false;
  if(/^[-—=·•]+$|^\w+:\/\/|^\d{1,2}:\d{2}\b/.test(line)||/20\d{2}\s*[-/.年]/.test(line)||/1\d{2}[\d*•]{4}\d{4}/.test(line))return false;
  // Recipient/address and specification rows are not product titles.
  if(/(?:省|自治区).{1,20}(?:市|区|县)|(?:市|区|县).{1,25}(?:路|大道|街道|街|小区|单元|室)/.test(line))return false;
  if(/^[\d.]+\s*(?:kg|g|ml|cm|mm|寸|码|斤|公斤)(?:$|[;\s/|])/i.test(line)||/^[A-Z0-9 -]{1,8}[;|]/.test(line))return false;
  const cleaned=cleanTitle(line);
  return cleaned.length>=(labeled?1:4)&&cleaned.length<=200&&/[\p{L}]/u.test(cleaned);
}

function parseNames(lines){
  let merchant='',merchantIndex=-1;
  for(let i=0;i<lines.length;i++){
    if(MERCHANT_LABEL.test(lines[i])){
      const value=cleanMerchant(lines[i].replace(MERCHANT_LABEL,'')||lines[i+1]||'');
      if(value&&!MONEY_ROW.test(value)&&!METADATA.test(value)&&!STATUS.test(value)&&!TITLE_LABEL.test(value)){merchant=value;merchantIndex=i;break;}
    }
  }
  if(!merchant){
    merchantIndex=lines.findIndex(line=>SHOP_SUFFIX.test(cleanMerchant(line))&&!TITLE_LABEL.test(line)&&!MONEY_ROW.test(line)&&!NAVIGATION.test(cleanMerchant(line)));
    if(merchantIndex>=0)merchant=cleanMerchant(lines[merchantIndex]);
  }
  const groups=[];
  let current=null;
  for(let i=0;i<lines.length;i++){
    const labeled=TITLE_LABEL.test(lines[i]), line=labeled?lines[i].replace(TITLE_LABEL,''):lines[i];
    if(labeled&&!line){current=null;continue;}
    const followsLabel=i>0&&TITLE_LABEL.test(lines[i-1])&&!lines[i-1].replace(TITLE_LABEL,'');
    const hasPrice=/¥\s*\d/.test(line);
    // A short alphanumeric fragment from the product thumbnail must not split
    // the actual title into separate products (e.g. an OCR-detected "0OO").
    if(!labeled&&/^[A-Za-z0-9]{1,3}$/.test(line))continue;
    if(!isNameLine(line,merchant,labeled||followsLabel)){current=null;continue;}
    const name=cleanTitle(line);
    if(current&&!labeled&&!followsLabel&&current.lines.length<3&&!(current.hasPrice&&hasPrice)){
      current.lines.push(name);current.end=i;current.hasPrice ||= hasPrice;
    }else{
      current={lines:[name],start:i,end:i,labeled:labeled||followsLabel,hasPrice};groups.push(current);
    }
  }
  for(const group of groups){
    const next=lines.slice(group.end+1,group.end+4);
    group.itemEvidence=group.hasPrice||next.some(l=>/^(?:¥\s*\d|[x×]\s*\d)/i.test(l));
    const nearShop=merchantIndex>=0&&group.start>merchantIndex&&group.start-merchantIndex<=6;
    group.score=(group.labeled?200:0)+(nearShop?50:0)+(group.itemEvidence?25:0)+Math.min(group.lines.join('').length,30);
  }
  groups.sort((a,b)=>b.score-a.score||a.start-b.start);
  const chosen=groups[0];
  const items=groups.filter(g=>g.itemEvidence||g.labeled);
  const multiple=items.length>1;
  let title=chosen?.lines.join(' ')||'';
  if(multiple)title+=' 等多件商品';
  return {title:title.slice(0,200),merchant:merchant.slice(0,200),multiple};
}

function parseOrderNo(text){
  const match=text.match(/(?:订单(?:编号|号码|号)|交易(?:单号|编号)|商户单号)\s*[:;]?\s*([A-Za-z0-9][A-Za-z0-9 -]{4,80}[A-Za-z0-9])(?![A-Za-z0-9-])/);
  if(!match)return '';
  const value=match[1].trim();
  // Only collapse spaces for digit-only IDs; do not join unrelated Latin labels.
  const normalized=/^[\d ]+$/.test(value)?value.replace(/ /g,''):value;
  return /^[A-Za-z0-9-]{6,60}$/.test(normalized)?normalized:'';
}

function parseReceipt(raw, settings=DEFAULT_SETTINGS, today=localDate()) {
  const text=normalize(raw), lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
  const amountResult=parseAmount(lines), purchase=parsePurchaseDate(text);
  const purchasedAt=purchase.date,purchasedTime=purchase.time;
  const {title,merchant,multiple}=parseNames(lines);
  const categoryText=title+' '+merchant;
  const category=/酒店|民宿|住宿|宾馆/.test(categoryText)?'差旅住宿':/高铁|火车|打车|滴滴|出租|机票|地铁|汽油|加油|停车/.test(categoryText)?'交通出行':/餐|饭|咖啡|奶茶|茶饮|食品|美食/.test(categoryText)?'餐饮招待':/鼠标|键盘|显示器|电脑|耳机|硬盘|充电|手机|数码|USB/.test(categoryText)?'数码设备':/订阅|软件|云服务|域名|会员|license/i.test(categoryText)?'软件服务':/纸|笔|文件|打印|办公|文具/.test(categoryText)?'办公用品':'其他支出';
  const warnings=[];
  if(!title)warnings.push('未找到商品名称');
  if(amountResult.amount===null)warnings.push(amountResult.foreign?'检测到外币，请核对实际人民币支出':amountResult.ambiguous?'检测到多个可能的金额，无法确定订单实付，请手动核对':'未找到明确的实付金额');
  if(multiple)warnings.push('检测到多个商品，当前记录按整笔订单保存，请核对商品名称和订单总额；分别报销时请手动拆分');
  if(!purchasedAt)warnings.push('未找到完整购买日期');
  if(/待付款|待支付|未付款|已关闭|已取消|退款成功/.test(text))warnings.push('图片可能是未支付、已取消或已退款订单');
  return {title:title||'待核对的消费',merchant,amount:amountResult.amount,purchasedAt,purchasedTime,category,orderNo:parseOrderNo(text),invoiceDueDate:addDays(purchasedAt||today,settings.invoiceDays),reimbursementDueDate:addDays(purchasedAt||today,settings.reimbursementDays),warnings,rawText:text};
}
module.exports={normalize,parseDate,parseAmount,parseReceipt};
