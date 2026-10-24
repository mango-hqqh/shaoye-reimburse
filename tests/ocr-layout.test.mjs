import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {tileRegions, mapTileLines, readingOrder} = require('../electron/ocr-layout.cjs');

function line(text, x0, y0, x1, y1, confidence = 0.95) {
  return {text, x0, y0, x1, y1, confidence};
}

test('单屏和恰好达到切片高度的截图保留完整内容', () => {
  for (const height of [1, 600, 1536]) {
    assert.deepEqual(tileRegions(height), [{top:0, height, keepTop:0, keepBottom:height}]);
  }
});

test('刚超过切片边界及多屏长图的保留范围无空隙、无重叠', () => {
  for (const height of [1537, 2880, 2881, 4224, 5000, 20000]) {
    const tiles = tileRegions(height);
    assert.equal(tiles[0].top, 0);
    assert.equal(tiles[0].keepTop, 0);
    assert.equal(tiles.at(-1).keepBottom, height);
    assert.equal(tiles.at(-1).top + tiles.at(-1).height, height);
    for (const [index, tile] of tiles.entries()) {
      assert.ok(tile.height > 0 && tile.height <= 1536);
      assert.ok(tile.top <= tile.keepTop && tile.keepTop < tile.keepBottom);
      assert.ok(tile.keepBottom <= tile.top + tile.height);
      if (index > 0) {
        const previous = tiles[index - 1];
        assert.equal(previous.keepBottom, tile.keepTop, `height=${height}, seam=${index}`);
        assert.ok(previous.top + previous.height > tile.top, '相邻切片必须重叠以保留完整文字');
      }
    }
  }
});

test('同一文字在重叠区被两张切片识别时，接缝前、接缝上和接缝后均只保留一次', () => {
  const tiles = tileRegions(2880);
  const expected = [
    line('商品金额', 30, 1410, 220, 1430),
    line('实付款 ¥299.00', 30, 1430, 320, 1450),
    line('支付时间', 30, 1450, 220, 1470),
  ];
  const actual = tiles.flatMap(tile => mapTileLines({
    resizedImageWidth:768,
    resizedImageHeight:1536,
    texts:expected.map(item => ({text:item.text, mean:item.confidence, box:[
      [item.x0 + 9, item.y0 - tile.top],
      [item.x1 + 9, item.y0 - tile.top],
      [item.x1 + 9, item.y1 - tile.top],
      [item.x0 + 9, item.y1 - tile.top],
    ]})),
  }, tile, 750));
  assert.deepEqual(actual, expected);
  assert.equal(readingOrder(actual), '商品金额\n实付款 ¥299.00\n支付时间');
});

test('坐标映射消除横向留白并恢复切片在整张图上的纵向位置', () => {
  const result = mapTileLines({resizedImageWidth:800, resizedImageHeight:200,
    texts:[{text:'  螺丝刀  ', score:0.91, box:[[100,30],[300,30],[300,70],[100,70]]}]},
  {top:1344, height:200, keepTop:1344, keepBottom:1544}, 750);
  assert.deepEqual(result, [line('螺丝刀', 75, 1374, 275, 1414, 0.91)]);
});

test('坐标映射同时恢复等比放大和竖向留白', () => {
  const result = mapTileLines({resizedImageWidth:1000, resizedImageHeight:640,
    texts:[{text:'实付 ¥58.80', mean:0.9, box:[[20,40],[300,40],[300,80],[20,80]]}]},
  {top:1000, height:300, keepTop:1000, keepBottom:1300}, 500);
  assert.deepEqual(result, [line('实付 ¥58.80', 10, 1010, 150, 1030, 0.9)]);
});

test('无文本、无文本框和重叠区之外的框不进入提取文本', () => {
  const tile = {top:1000, height:500, keepTop:1100, keepBottom:1400};
  const box = center => [[0,center-10],[100,center-10],[100,center+10],[0,center+10]];
  const result = mapTileLines({texts:[
    {text:'   ', mean:0.9, box:box(200)},
    {text:'无坐标', mean:0.9},
    {text:'上一片负责', mean:0.9, box:box(99)},
    {text:'下一片负责', mean:0.9, box:box(400)},
    {text:'本片负责', mean:0.9, box:box(100)},
  ]}, tile, 750);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, '本片负责');
});

test('行排序将左右分列的标签与金额合并，保留下一行，且不改变原始数组', () => {
  const lines = [
    line('¥299.00', 600, 92, 720, 126),
    line('2026-10-23 18:30:00', 400, 160, 720, 180),
    line('支付时间', 30, 162, 160, 182),
    line('实付款', 30, 100, 150, 120),
    line('罗技无线鼠标', 30, 20, 300, 44),
  ];
  const before = structuredClone(lines);
  assert.equal(readingOrder(lines), '罗技无线鼠标\n实付款 ¥299.00\n支付时间 2026-10-23 18:30:00');
  assert.deepEqual(lines, before);
});

test('同名商品出现在不同行时保留重复文字，空识别结果安全返回空字符串', () => {
  assert.equal(readingOrder([line('螺丝刀', 30, 100, 200, 120), line('螺丝刀', 30, 30, 200, 50)]), '螺丝刀\n螺丝刀');
  assert.equal(readingOrder([]), '');
  assert.deepEqual(mapTileLines({}, {top:0,height:600,keepTop:0,keepBottom:600}, 750), []);
});
