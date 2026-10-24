# Downloads HELPER's speech engine into vendor\: whisper.cpp for NVIDIA graphics cards (685 MB, from GitHub
# ggml-org/whisper.cpp) and ivrit.ai's Hebrew model (1.6 GB, from Hugging Face). Both run on this PC only.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vendor = Join-Path $here 'vendor'
New-Item -ItemType Directory -Force $vendor | Out-Null
$ProgressPreference = 'SilentlyContinue'

$server = Join-Path $vendor 'whisper\Release\whisper-server.exe'
if (-not (Test-Path $server)) {
    Write-Host 'Downloading whisper.cpp (CUDA 12.4, 685 MB)...'
    $zip = Join-Path $vendor 'whisper-cuda.zip'
    Invoke-WebRequest -UseBasicParsing 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip' -OutFile $zip
    Expand-Archive -Force $zip (Join-Path $vendor 'whisper')
    Remove-Item $zip
}
$model = Join-Path $vendor 'ggml-ivrit-turbo.bin'
if (-not (Test-Path $model)) {
    Write-Host 'Downloading the Hebrew model (ivrit.ai whisper-large-v3-turbo, 1.6 GB)...'
    Invoke-WebRequest -UseBasicParsing 'https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin' -OutFile $model
}
Write-Host 'Speech engine ready.'
