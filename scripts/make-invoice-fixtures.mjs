import {createCanvas} from '@napi-rs/canvas';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const folder=resolve('tests/fixtures');
await mkdir(folder,{recursive:true});
const expected={amount:128.6,seller:'鼎固五金旗舰店',item:'304不锈钢内六角螺丝',orderNo:'2398217645086312',issuedAt:'2026-10-23',purchasedAt:'2026-10-21',textInvoiceNo:'24612000000012345678',scanInvoiceNo:'24612000000012345679'};
const lines=number=>[
  '电子发票（普通发票）',
  '发票号码：'+number,
  '开票日期：2026年10月23日',
  '购买方名称：测试研发有限公司',
  '销售方名称：鼎固五金旗舰店',
  '项目名称        数量       金额       税额',
  '*金属制品*304不锈钢内六角螺丝',
  '合计金额：113.81       合计税额：14.79',
  '价税合计（大写）：壹佰贰拾捌元陆角',
  '（小写）￥128.60',
  '备注：订单编号：2398217645086312',
  '本文件为程序验收生成的虚构样本，不能用于报销',
];
function pdf(objects){
  const chunks=[Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n','binary')],offsets=[0];
  let length=chunks[0].length;
  for(let index=0;index<objects.length;index++){
    const chunk=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),Buffer.isBuffer(objects[index])?objects[index]:Buffer.from(objects[index]),Buffer.from('\nendobj\n')]);
    offsets.push(length);chunks.push(chunk);length+=chunk.length;
  }
  chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
const stream=(bytes,attrs='')=>Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${attrs} >>\nstream\n`),bytes,Buffer.from('\nendstream')]);
const hex=value=>Buffer.from(value,'utf16le').swap16().toString('hex');
const textContent=Buffer.from(lines(expected.textInvoiceNo).map((line,index)=>`BT /F1 ${index===0?24:16} Tf 1 0 0 1 40 ${740-index*44} Tm <${hex(line)}> Tj ET`).join('\n'));
const textObjects=[
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
  '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 6 0 R /DW 1000 >>',
  '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-250 -250 1250 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
  stream(textContent),
];
await writeFile(join(folder,'invoice-text.pdf'),pdf(textObjects));
function raster(number){
  const canvas=createCanvas(1400,1600),ctx=canvas.getContext('2d');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1400,1600);ctx.fillStyle='#202024';
  lines(number).forEach((line,index)=>{ctx.font=`${index===0?'bold 50':34}px "Microsoft YaHei"`;ctx.fillText(line,65,110+index*110);});
  return canvas.toBuffer('image/jpeg',92);
}
const scan=raster(expected.scanInvoiceNo);
const scanContent=Buffer.from('q 700 0 0 800 0 0 cm /Im1 Do Q');
await writeFile(join(folder,'invoice-scan.pdf'),pdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 800] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
  stream(scan,'/Type /XObject /Subtype /Image /Width 1400 /Height 1600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'),
  stream(scanContent),
]));
await writeFile(join(folder,'invoice-original.jpg'),raster('24612000000012345680'));
// A second page has a selectable heading over a scanned invoice. The first
// page's readable total must not suppress OCR of the second page.
const mixed=[...textObjects];
mixed[1]='<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>';
const heading='附件扫描页面说明：以下内容为程序生成的测试数据，扫描页上方存在可选择的文字，但是票号与金额都保存在图像中。';
mixed.push(
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 700 800] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 10 0 R >> >> /Contents 9 0 R >>',
  stream(Buffer.from('q 700 0 0 800 0 0 cm /Im1 Do Q\nBT /F1 9 Tf 1 0 0 1 20 785 Tm <'+hex(heading)+'> Tj ET')),
  stream(scan,'/Type /XObject /Subtype /Image /Width 1400 /Height 1600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'),
);
await writeFile(join(folder,'invoice-mixed.pdf'),pdf(mixed));
await writeFile(join(folder,'invoices.expected.json'),JSON.stringify(expected,null,2));
console.log('Created synthetic text PDF, scanned PDF and original JPEG invoice fixtures.');
