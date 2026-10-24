$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Synthetic mobile order screenshots: all people, stores and order numbers below
# are test data. The fixed layout and dates make OCR regressions reproducible.
$fixtureFolder = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tests\fixtures'))
[System.IO.Directory]::CreateDirectory($fixtureFolder) | Out-Null

function Color([string]$hex) {
    return [System.Drawing.ColorTranslator]::FromHtml($hex)
}

function Draw-Box($g, [float]$x, [float]$y, [float]$width, [float]$height, [string]$color, [float]$radius = 0) {
    $brush = [System.Drawing.SolidBrush]::new((Color $color))
    try {
        if ($radius -le 0) {
            $g.FillRectangle($brush, $x, $y, $width, $height)
        } else {
            $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
            try {
                $diameter = $radius * 2
                $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
                $path.AddArc(($x + $width - $diameter), $y, $diameter, $diameter, 270, 90)
                $path.AddArc(($x + $width - $diameter), ($y + $height - $diameter), $diameter, $diameter, 0, 90)
                $path.AddArc($x, ($y + $height - $diameter), $diameter, $diameter, 90, 90)
                $path.CloseFigure()
                $g.FillPath($brush, $path)
            } finally { $path.Dispose() }
        }
    } finally { $brush.Dispose() }
}

function Draw-Text($g, [string]$text, [float]$x, [float]$y, [float]$size = 26, [string]$color = '#222222', [bool]$bold = $false) {
    $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
    $font = [System.Drawing.Font]::new('Microsoft YaHei', $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.SolidBrush]::new((Color $color))
    try { $g.DrawString($text, $font, $brush, [float]$x, [float]$y) }
    finally { $font.Dispose(); $brush.Dispose() }
}

function Draw-Line($g, [float]$x1, [float]$y1, [float]$x2, [float]$y2, [string]$color = '#e9e9e9', [float]$width = 1) {
    $pen = [System.Drawing.Pen]::new((Color $color), $width)
    try { $g.DrawLine($pen, $x1, $y1, $x2, $y2) }
    finally { $pen.Dispose() }
}

function Draw-Money($g, [string]$whole, [string]$fraction, [float]$x, [float]$y, [string]$color = '#ff5000') {
    # Price components share a baseline but deliberately have different heights,
    # matching common marketplace UI rather than a single OCR-friendly text row.
    Draw-Text $g '¥' $x ($y + 13) 25 $color $true
    Draw-Text $g $whole ($x + 24) $y 42 $color $true
    $decimalX = $x + 24 + $whole.Length * 27
    Draw-Text $g ('.' + $fraction) $decimalX ($y + 13) 25 $color $true
}

function Draw-PhoneHeader($g, [string]$time, [string]$background) {
    Draw-Box $g 0 0 750 140 $background
    Draw-Text $g $time 38 14 25 '#161616' $true
    Draw-Text $g '5G' 617 17 20 '#161616' $true
    Draw-Box $g 668 20 42 20 '#232323' 4
    Draw-Box $g 711 26 4 8 '#232323'
    Draw-Line $g 44 82 29 98 '#222222' 3
    Draw-Line $g 29 98 44 114 '#222222' 3
    Draw-Text $g '订单详情' 294 74 31 '#202020' $true
    Draw-Text $g '···' 676 73 29 '#202020' $true
}

function Draw-Address($g, [float]$y) {
    Draw-Box $g 24 $y 702 160 '#ffffff' 20
    Draw-Text $g '收货信息' 47 ($y + 18) 24 '#777777'
    Draw-Text $g '测试用户  138****0000' 47 ($y + 58) 27 '#222222' $true
    Draw-Text $g '浙江省 杭州市 西湖区 测试路 88 号' 47 ($y + 105) 24 '#666666'
}

function Draw-ScrewThumbnail($g, [float]$x, [float]$y) {
    Draw-Box $g $x $y 172 172 '#e9e9e7' 10
    foreach ($offset in @(0, 43, 86)) {
        $pen = [System.Drawing.Pen]::new((Color '#777e83'), 14)
        $brush = [System.Drawing.SolidBrush]::new((Color '#91989b'))
        try {
            $g.DrawLine($pen, ($x + 41 + $offset), ($y + 36), ($x + 27 + $offset), ($y + 126))
            $g.FillEllipse($brush, ($x + 23 + $offset), ($y + 20), 36, 34)
            Draw-Box $g ($x + 34 + $offset) ($y + 28) 13 13 '#44494d' 3
            for ($thread = 0; $thread -lt 9; $thread++) {
                Draw-Line $g ($x + 29 + $offset - $thread) ($y + 62 + $thread * 7) ($x + 43 + $offset - $thread) ($y + 65 + $thread * 7) '#b9bdc0' 2
            }
        } finally { $pen.Dispose(); $brush.Dispose() }
    }
}

function Draw-MouseThumbnail($g, [float]$x, [float]$y) {
    Draw-Box $g $x $y 172 172 '#eeeef0' 10
    $body = [System.Drawing.SolidBrush]::new((Color '#43474b'))
    $wheel = [System.Drawing.SolidBrush]::new((Color '#a6aaad'))
    try {
        $g.FillEllipse($body, ($x + 37), ($y + 19), 104, 138)
        $g.FillEllipse($body, ($x + 19), ($y + 80), 70, 69)
        Draw-Line $g ($x + 89) ($y + 23) ($x + 89) ($y + 81) '#202427' 3
        $g.FillEllipse($wheel, ($x + 82), ($y + 40), 14, 27)
        Draw-Line $g ($x + 59) ($y + 90) ($x + 121) ($y + 89) '#272a2e' 2
    } finally { $body.Dispose(); $wheel.Dispose() }
}

function New-Fixture([string]$platform, [string]$fileName, [int]$height) {
    $bitmap = [System.Drawing.Bitmap]::new(750, $height)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear((Color '#f4f4f4'))
    try {
        if ($platform -eq 'taobao') {
            Draw-PhoneHeader $g '14:36' '#fff2e8'
            Draw-Box $g 0 140 750 165 '#fff2e8'
            Draw-Text $g '交易成功' 42 156 40 '#f25119' $true
            Draw-Text $g '感谢您的购买，欢迎再次光临' 44 222 25 '#8b5a40'
            Draw-Address $g 305

            Draw-Box $g 24 484 702 392 '#ffffff' 20
            Draw-Text $g '鼎固五金旗舰店  ›' 46 507 29 '#222222' $true
            Draw-ScrewThumbnail $g 46 568
            Draw-Text $g '304不锈钢内六角螺丝' 237 565 29 '#222222'
            Draw-Text $g 'M4×20 100颗装' 237 607 28 '#222222'
            Draw-Text $g '颜色分类：本色  规格：M4×20' 237 656 22 '#888888'
            Draw-Text $g '¥148.60' 237 706 28 '#333333'
            Draw-Text $g '×1' 654 707 24 '#777777'
            Draw-Text $g '七天无理由退货  ·  退货运费险' 46 775 23 '#777777'
            Draw-Box $g 554 809 139 48 '#f5f5f5' 24
            Draw-Text $g '申请售后' 573 818 22 '#444444'

            Draw-Box $g 24 895 702 335 '#ffffff' 20
            Draw-Text $g '商品总价' 47 916 26 '#666666'
            Draw-Text $g '¥148.60' 590 916 26 '#333333'
            Draw-Text $g '运费' 47 970 26 '#666666'
            Draw-Text $g '¥0.00' 618 970 26 '#333333'
            Draw-Text $g '店铺优惠' 47 1024 26 '#666666'
            Draw-Text $g '-¥20.00' 588 1024 26 '#ff5000'
            Draw-Line $g 47 1084 702 1084
            Draw-Text $g '实付款' 47 1107 29 '#222222' $true
            Draw-Money $g '128' '60' 529 1097 '#ff5000'
            Draw-Text $g '支付方式：支付宝' 47 1178 23 '#888888'

            Draw-Box $g 24 1249 702 303 '#ffffff' 20
            Draw-Text $g '订单信息' 47 1269 29 '#222222' $true
            Draw-Text $g '订单编号' 47 1327 23 '#888888'
            Draw-Text $g '2398217645086312' 257 1327 24 '#555555'
            Draw-Text $g '复制' 649 1327 22 '#777777'
            Draw-Text $g '创建时间' 47 1378 23 '#888888'
            Draw-Text $g '2026-10-21 14:28:06' 257 1378 24 '#555555'
            Draw-Text $g '付款时间' 47 1429 23 '#888888'
            Draw-Text $g '2026-10-21 14:30:28' 257 1429 24 '#555555'
            Draw-Text $g '成交时间' 47 1480 23 '#888888'
            Draw-Text $g '2026-10-23 09:16:05' 257 1480 24 '#555555'
        } else {
            Draw-PhoneHeader $g '10:24' '#ffffff'
            Draw-Box $g 0 140 750 165 '#fff0ef'
            Draw-Text $g '已完成' 42 157 40 '#d83432' $true
            Draw-Text $g '您的订单已完成，感谢您在京东购物' 44 222 25 '#985b5b'
            Draw-Address $g 305

            Draw-Box $g 24 484 702 407 '#ffffff' 20
            Draw-Text $g '罗技京东自营旗舰店  ›' 46 507 29 '#222222' $true
            Draw-MouseThumbnail $g 46 570
            Draw-Text $g '罗技（Logitech）无线蓝牙鼠标' 237 568 26 '#222222'
            Draw-Text $g 'MX Master 3S 办公静音' 237 610 28 '#222222'
            Draw-Text $g '颜色：石墨黑  版本：标准版' 237 659 22 '#888888'
            Draw-Text $g '¥699.00' 237 707 28 '#333333'
            Draw-Text $g '×1' 654 709 24 '#777777'
            Draw-Text $g '京东物流  ·  7天价保  ·  免费上门退换' 46 779 23 '#777777'
            Draw-Box $g 554 827 139 48 '#f5f5f5' 24
            Draw-Text $g '申请售后' 573 835 22 '#444444'

            Draw-Box $g 24 910 702 378 '#ffffff' 20
            Draw-Text $g '商品金额' 47 932 26 '#666666'
            Draw-Text $g '¥699.00' 590 932 26 '#333333'
            Draw-Text $g '运费' 47 986 26 '#666666'
            Draw-Text $g '¥0.00' 618 986 26 '#333333'
            Draw-Text $g '优惠券' 47 1040 26 '#666666'
            Draw-Text $g '-¥100.00' 573 1040 26 '#e4393c'
            Draw-Text $g '京豆' 47 1094 26 '#666666'
            Draw-Text $g '-¥0.00' 608 1094 26 '#e4393c'
            Draw-Line $g 47 1150 702 1150
            Draw-Text $g '实付金额' 47 1173 29 '#222222' $true
            Draw-Money $g '599' '00' 529 1163 '#e4393c'
            Draw-Text $g '在线支付  ·  微信支付' 47 1242 23 '#888888'

            Draw-Box $g 24 1307 702 304 '#ffffff' 20
            Draw-Text $g '订单信息' 47 1327 29 '#222222' $true
            Draw-Text $g '订单编号' 47 1385 23 '#888888'
            Draw-Text $g '284398276510' 257 1385 24 '#555555'
            Draw-Text $g '复制' 649 1385 22 '#777777'
            Draw-Text $g '下单时间' 47 1436 23 '#888888'
            Draw-Text $g '2026-10-22 10:16:03' 257 1436 24 '#555555'
            Draw-Text $g '支付时间' 47 1487 23 '#888888'
            Draw-Text $g '2026-10-22 10:18:45' 257 1487 24 '#555555'
            Draw-Text $g '完成时间' 47 1538 23 '#888888'
            Draw-Text $g '2026-10-23 08:52:10' 257 1538 24 '#555555'

            Draw-Box $g 24 1630 702 79 '#ffffff' 20
            Draw-Text $g '发票信息' 47 1653 26 '#333333'
            Draw-Text $g '电子普通发票  ›' 492 1653 25 '#777777'
        }

        $footerY = $height - 90
        Draw-Text $g '合成回归测试截图 · 非真实订单' 177 $footerY 22 '#8b8b8b'
        Draw-Box $g 270 ($height - 24) 210 7 '#222222' 3
        $imagePath = Join-Path $fixtureFolder $fileName
        $bitmap.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Output "$imagePath (750 x $height)"
    } finally { $g.Dispose(); $bitmap.Dispose() }
}

New-Fixture 'taobao' 'taobao-order.png' 1680
New-Fixture 'jd' 'jd-order.png' 1830

$expectedJson = @'
[
  {
    "file": "taobao-order.png",
    "synthetic": true,
    "platform": "淘宝",
    "titleKeywords": ["304", "不锈钢", "内六角", "螺丝"],
    "title": "304不锈钢内六角螺丝 M4×20 100颗装",
    "merchant": "鼎固五金旗舰店",
    "amount": 128.60,
    "purchaseDate": "2026-10-21",
    "purchaseTime": "14:30:28",
    "orderNo": "2398217645086312"
  },
  {
    "file": "jd-order.png",
    "synthetic": true,
    "platform": "京东",
    "titleKeywords": ["罗技", "无线", "蓝牙", "鼠标"],
    "title": "罗技（Logitech）无线蓝牙鼠标 MX Master 3S 办公静音",
    "merchant": "罗技京东自营旗舰店",
    "amount": 599.00,
    "purchaseDate": "2026-10-22",
    "purchaseTime": "10:18:45",
    "orderNo": "284398276510"
  }
]
'@
[System.IO.File]::WriteAllText((Join-Path $fixtureFolder 'orders.expected.json'), $expectedJson.Replace("`r`n", "`n").TrimEnd() + "`n", [System.Text.UTF8Encoding]::new($false))
