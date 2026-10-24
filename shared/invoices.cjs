const { validDate } = require('./domain.cjs');

// Invoice dates and totals have different meanings from shopping-order fields.
// In particular, never feed the invoice text into the purchase receipt parser.
function normalizeInvoiceText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\r/g, '').replace(/￥/g, '¥').replace(/[−﹣－]/g, '-')
    .replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g, '')
    .replace(/销\s*售\s*方/g, '销售方').replace(/购\s*买\s*方/g, '购买方')
    .replace(/[ \t]+/g, ' ').trim();
}

function totalAfterLabel(value) {
  // A currency sign may be on its own line, but do not cross an intervening
  // field label or silently extract a piece of an account / invoice number.
  const match = value.match(/^[\s:;()]*([+-]?)\s*(?:¥\s*)?([+-]?)\s*(\d{1,3}(?:\s*,\s*\d{3})+|\d{1,8})(?:\s*[.。]\s*(\d{1,2}))?(?:\s*元)?(?![\d.,。])/);
  if (!match) return null;
  if (/^[ \t]*(?:¥|[-+]?\d)/.test(value.slice(match[0].length))) return null;
  const amount = Number(match[3].replace(/[\s,]/g, '') + (match[4] ? '.' + match[4] : ''));
  if (!Number.isFinite(amount) || amount > 99999999) return null;
  return (match[1] === '-' || match[2] === '-' ? -1 : 1) * amount;
}

function parseTotal(text, warnings) {
  if (/(?:USD|HKD|HK\$|US\$|美元|港币|港元|EUR|欧元|GBP|英镑|JPY|日元|[$€£])/i.test(text)) {
    warnings.push('检测到外币金额，请手动核对人民币报销金额');
    return null;
  }
  const smallLabels = [...text.matchAll(/(?:\(\s*)?小写\s*\)?/g)];
  const labels = smallLabels.length ? smallLabels : [...text.matchAll(/价税合计/g)];
  const amounts = labels.map(label => totalAfterLabel(text.slice(label.index + label[0].length)));
  const unique = [...new Set(amounts)];
  if (!labels.length || unique.length !== 1 || unique[0] === null) {
    warnings.push(unique.length > 1 ? '识别到不同的价税合计，请核对原发票' : '未识别到明确的价税合计小写金额');
    return null;
  }
  return unique[0];
}

function readDate(text) {
  const match = text.match(/开票日期\s*[:;]?\s*(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?:\s*日)?(?!\d)/);
  if (!match) return '';
  const date = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
  return validDate(date) ? date : '';
}

function readInvoiceNo(text) {
  const match = text.match(/发票(?:号码|号)(?:码)?\s*[:;]?\s*([0-9][0-9 \t]{6,40}[0-9])(?![0-9])/);
  if (!match) return '';
  const value = match[1].replace(/\s/g, '');
  return /^(?:\d{8}|\d{20})$/.test(value) ? value : '';
}

function readOrderNos(text) {
  const matches = [...text.matchAll(/(?:订单(?:编号|号码|号)|交易(?:单号|编号)|商户单号)\s*[:;]?\s*([A-Za-z0-9][A-Za-z0-9 \t-]{4,80}[A-Za-z0-9])(?![A-Za-z0-9-])/g)];
  return [...new Set(matches.map(match => {
    const raw = match[1].trim();
    const value = /^[\d \t]+$/.test(raw) ? raw.replace(/\s/g, '') : raw;
    return /^[A-Za-z0-9-]{6,60}$/.test(value) ? value : '';
  }).filter(Boolean))];
}

const PARTY_STOP = /购买方|销售方|纳税人|统一社会|识别号|地址|电话|开户行|开户银行|银行账号|货物|项目名称|规格型号|价税合计|开票人|备注|密码区/;
function cleanParty(value) {
  return value.replace(/^[\s:;]+/, '').split(PARTY_STOP)[0].trim().slice(0, 200);
}
function partyValue(value, nextLine = '') {
  let result = cleanParty(value);
  if (!result) result = cleanParty(nextLine);
  return result.length >= 2 && /[\p{L}]/u.test(result) && !/^(?:名称|信息|税号|合计)$/.test(result) ? result : '';
}

function readSeller(lines) {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], sellerAt = line.indexOf('销售方'), buyerAt = line.indexOf('购买方');
    if (sellerAt < 0) continue;
    // 数电票 commonly lays the parties out in two columns. Reading the first
    // following 名称 would otherwise assign the buyer's company as the seller.
    if (buyerAt >= 0) {
      for (const row of lines.slice(index, index + 5)) {
        const names = [...row.matchAll(/名称\s*[:;]?\s*/g)];
        if (names.length !== 2) continue;
        const wanted = sellerAt > buyerAt ? 1 : 0;
        const name = names[wanted];
        return partyValue(row.slice(name.index + name[0].length, names[wanted + 1]?.index ?? row.length));
      }
      // With flattened columns and no unambiguous pair, leave this blank.
      continue;
    }
    const suffix = line.slice(sellerAt + 3).replace(/^信息/, '');
    const direct = suffix.match(/^\s*(?:名称\s*)?[:;]\s*(.*)$/);
    if (direct) {
      const value = partyValue(direct[1], lines[index + 1]);
      if (value) return value;
    }
    const inline = suffix.match(/^\s*名称\s*[:;]?\s*(.*)$/);
    if (inline) {
      const value = partyValue(inline[1], lines[index + 1]);
      if (value) return value;
    }
    for (let offset = 1; offset <= 5 && index + offset < lines.length; offset++) {
      const row = lines[index + offset];
      if (/购买方|销售方|货物|项目名称|价税合计/.test(row)) break;
      const name = row.match(/^名称\s*[:;]?\s*(.*)$/);
      if (name) return partyValue(name[1], lines[index + offset + 1]);
    }
  }
  return '';
}

const ITEM_HEADER = /货物或应税劳务[、,]?服务名称|货物或应税劳务|应税劳务[、,]?服务名称|项目名称|商品名称/;
const ITEM_STOP = /^(?:合计|价税合计|购买方|销售方|备注|开票人|收款人|复核人|校验码|发票号码|密码区)/;
const ITEM_METADATA = /^(?:规格型号|单位|数量|单价|金额|税率|征收率|税额|名称|纳税人识别号|统一社会信用代码|地址|电话|开户行|银行账号)(?:$|[:;\s/])/;
const GENERIC_ITEMS = /^(?:货物|商品|材料|服务|办公用品|电子产品|日用品|其他|详见(?:销货|销售)?清单|见(?:销货|销售)?清单|销售货物|商品一批|详见附件)$/;
function cleanItem(value) {
  let item = value.replace(/^\*[^*\n]{1,40}\*\s*/, '').replace(/^[\s:;]+/, '').trim();
  // Strip quantity/price columns, keeping a model that belongs to the name.
  item = item.replace(/(?:\s+(?:(?:件|个|包|盒|套|台|本|张|支|只|块|瓶|卷|根|批|千克|kg|米|项)\s*)?|(?:件|个|包|盒|套|台|本|张|支|只|块|瓶|卷|根|批|千克|米|项)\s+)[-+]?\d+(?:\.\d+)?\s+[-+]?\d+(?:\.\d+)?[\s\S]*$/i, '');
  item = item.replace(/\s+[-+]?\d+[.,]\d{2}(?:\s|$)[\s\S]*$/, '').replace(/\s+\d+(?:\.\d+)?%[\s\S]*$/, '');
  item = item.replace(/\s+(?:件|个|包|盒|套|台|本|张|支|只|块|瓶|卷|根|批|千克|kg|米|项)\s*$/i, '').trim();
  if (!item || item.length > 200 || GENERIC_ITEMS.test(item) || ITEM_HEADER.test(item) || ITEM_METADATA.test(item) || !/[\p{L}]/u.test(item) || /^[-+¥\d,.\s%]+$/.test(item)) return '';
  return item;
}

function readItems(lines) {
  const items = [];
  let inTable = false;
  for (const line of lines) {
    if (ITEM_STOP.test(line)) { inTable = false; continue; }
    if (ITEM_HEADER.test(line)) {
      inTable = true;
      const labeled = line.match(/(?:项目名称|商品名称)\s*[:;]\s*(.+)/);
      if (labeled) { const item = cleanItem(labeled[1]); if (item) items.push(item); }
      continue;
    }
    if (/^\*[^*\n]+\*/.test(line)) {
      const item = cleanItem(line); if (item) items.push(item);
      continue;
    }
    // Bare names are useful only within an explicit item table. Do not treat
    // surrounding customer names, remarks or seller addresses as products.
    if (inTable && !ITEM_METADATA.test(line)) {
      const item = cleanItem(line); if (item) items.push(item);
    }
  }
  return [...new Set(items)].slice(0, 100);
}

function parseInvoice(raw) {
  const rawText = normalizeInvoiceText(raw), lines = rawText.split('\n').map(line => line.trim()).filter(Boolean);
  const warnings = [];
  const amount = parseTotal(rawText, warnings), invoiceNo = readInvoiceNo(rawText), issuedAt = readDate(rawText);
  const seller = readSeller(lines), items = readItems(lines), orderNos = readOrderNos(rawText);
  const invoiceNos=[...new Set([...rawText.matchAll(/发票(?:号码|号)(?:码)?\s*[:;]?\s*([0-9][0-9 \t]{6,40}[0-9])(?![0-9])/g)].map(match=>match[1].replace(/\s/g,'')).filter(value=>/^(?:\d{8}|\d{20})$/.test(value)))];
  if(invoiceNos.length>1)warnings.push('文件包含多张发票，请拆分为每张发票一个文件后重新导入');
  if (amount !== null && amount < 0 || /红字|红冲|负数发票/.test(rawText)) warnings.push('检测到红字或负数发票，请人工核对，不自动关联订单');
  if (!invoiceNo) warnings.push('未识别到明确的发票号码');
  if (!issuedAt) warnings.push('未识别到完整开票日期');
  if (!seller) warnings.push('未识别到明确的销售方名称');
  if (!items.length) warnings.push('未识别到明确的商品项目');
  return { amount, invoiceNo, invoiceNos, issuedAt, seller, items, orderNos, rawText, warnings };
}

function comparable(value) { return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function moneyCents(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001 ? Math.round(value * 100) : null; }
function sameProduct(item, title) {
  const left = comparable(item), right = comparable(title);
  if (!left || !right || GENERIC_ITEMS.test(left)) return false;
  if (left === right) return left.length >= 2;
  return Math.min(left.length, right.length) >= 3 && (left.includes(right) || right.includes(left));
}
function sameSeller(seller, merchant) {
  const left = comparable(seller), right = comparable(merchant);
  return Math.min(left.length, right.length) >= 4 && (left === right || left.includes(right) || right.includes(left));
}

function findInvoiceMatches(invoice, records, invoices = []) {
  const invoiceCents = moneyCents(invoice?.amount);
  const orderNos = new Set((Array.isArray(invoice?.orderNos) ? invoice.orderNos : []).map(value => String(value).normalize('NFKC').trim().replace(/\s/g, '')).filter(Boolean));
  const linked = new Set(invoices.filter(value => value?.recordId && !value.deletedAt && value.id !== invoice?.id).map(value => value.recordId));
  const red = typeof invoice?.amount === 'number' && invoice.amount < 0 || (invoice?.warnings || []).some(value => /红字|负数|红冲/.test(value));
  const candidates = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.id || record.deletedAt || record.status === 'reimbursed') continue;
    const recordCents = moneyCents(record.amount);
    const equalAmount = invoiceCents !== null && recordCents !== null && invoiceCents === recordCents;
    const orderMatch = Boolean(record.orderNo) && orderNos.has(String(record.orderNo).normalize('NFKC').replace(/\s/g, ''));
    const amountConflict = invoice?.amount !== null && invoice?.amount !== undefined && !equalAmount;
    if (!orderMatch && !equalAmount) continue;
    const product = (Array.isArray(invoice?.items) ? invoice.items : []).some(item => sameProduct(item, record.title));
    const seller = sameSeller(invoice?.seller, record.merchant);
    const hasInvoice = linked.has(record.id) || Boolean(record.invoiceId);
    const reasons = [orderMatch ? '订单号一致' : '金额一致'];
    if (orderMatch && equalAmount) reasons.push('金额一致');
    if (product) reasons.push('商品名称一致');
    if (seller) reasons.push('销售方与商家一致');
    if (orderMatch && amountConflict) reasons.push('金额不一致，需人工核对');
    if (!record.reviewed) reasons.push('订单尚未核对');
    if (hasInvoice) reasons.push('订单已有发票');
    const score = (orderMatch ? 100 : 30) + (equalAmount ? 20 : 0) + (product ? 15 : 0) + (seller ? 10 : 0);
    candidates.push({ recordId: record.id, score, reason: reasons.join('；'), orderMatch, amountConflict, equalAmount, evidence: product || seller, eligible: record.reviewed === true && !hasInvoice });
  }
  candidates.sort((a, b) => b.score - a.score || String(a.recordId).localeCompare(String(b.recordId)));
  const output = (recordId, reason) => ({ recordId, reason, candidates: candidates.map(({ recordId, score, reason }) => ({ recordId, score, reason })) });
  if (red) return output(null, '红字或负数发票需要人工核对');
  if ((invoice?.invoiceNos||[]).length>1||(invoice?.warnings||[]).some(value=>/多张发票/.test(value))) return output(null,'文件包含多张发票，请拆分后重新导入');
  const exactOrders = candidates.filter(candidate => candidate.orderMatch);
  if (exactOrders.length) {
    const candidate = exactOrders[0];
    if (exactOrders.length > 1) return output(null, '多个订单号匹配，需要人工确认');
    if (candidate.amountConflict) return output(null, '订单号一致但金额不一致，需要人工确认');
    if (!candidate.eligible) return output(null, candidate.reason + '，需要人工确认');
    // An unread total is not a conflict, but an ambiguous total must not allow
    // the order-number shortcut to silently select one of several invoices.
    if ((invoice?.warnings || []).some(value => /不同的价税合计|外币/.test(value))) return output(null, '发票金额需人工核对');
    return output(candidate.recordId, candidate.reason);
  }
  const sameAmount = candidates.filter(candidate => candidate.equalAmount);
  if (sameAmount.length > 1) return output(null, '存在多个同金额订单，需要人工确认');
  if (sameAmount.length === 1) {
    const candidate = sameAmount[0];
    if (candidate.eligible && candidate.evidence && invoiceCents > 0) return output(candidate.recordId, candidate.reason);
    return output(null, candidate.eligible ? '仅金额一致，缺少明确商品或商家依据，请人工确认' : candidate.reason + '，需要人工确认');
  }
  return output(null, '未找到可确认的未报销订单，请手动选择');
}

module.exports = { parseInvoice, findInvoiceMatches };
