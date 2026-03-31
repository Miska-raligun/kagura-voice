# discovery_relay.ps1
# Windows 侧 UDP 发现中继（无需安装 Python）
# 接收 M5Stack 的 KAGURA_DISCOVER 广播，回复 KAGURA_HERE

$Port = 5001
$ReplyBytes = [System.Text.Encoding]::ASCII.GetBytes("KAGURA_HERE")

$udpClient = New-Object System.Net.Sockets.UdpClient($Port)
Write-Host "[discovery] 监听 UDP :$Port，等待设备广播..."

try {
    while ($true) {
        $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        $data   = $udpClient.Receive([ref]$remote)
        $msg    = [System.Text.Encoding]::ASCII.GetString($data).Trim()
        if ($msg -eq "KAGURA_DISCOVER") {
            $udpClient.Send($ReplyBytes, $ReplyBytes.Length, $remote) | Out-Null
            Write-Host "[discovery] 已回应 $($remote.Address)"
        }
    }
} finally {
    $udpClient.Close()
}
