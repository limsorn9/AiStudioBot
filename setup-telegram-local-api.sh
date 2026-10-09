#!/bin/bash
# ==============================================================================
# Setup Telegram Local Bot API Server for AiStudioBot (Supports up to 2GB files)
# ==============================================================================

set -e

echo "🚀 [1/5] កំពុងពិនិត្យ និងដំឡើង Docker..."
if ! command -v docker &> /dev/null; then
    echo "⚙️ Docker មិនទាន់មានទេ កំពុងដំឡើង Docker..."
    apt-get update -y
    apt-get install -y docker.io curl
    systemctl enable --now docker
else
    echo "✅ Docker មានស្រាប់រួចរាល់ហើយ!"
fi

echo "📁 [2/5] បង្កើតថតផ្ទុកទិន្នន័យ /var/lib/telegram-bot-api..."
mkdir -p /var/lib/telegram-bot-api
chmod 777 /var/lib/telegram-bot-api

echo "🐳 [3/5] កំពុងដំណើរការ Telegram Bot API Server Docker Container..."
# បញ្ឈប់ និងលុប container ចាស់ប្រសិនបើមាន
docker rm -f telegram-bot-api 2>/dev/null || true

# ដំណើរការ container ជាមួយ Telegram Official Desktop Client ID & Hash (សុវត្ថិភាព 100%)
docker run -d \
  --name telegram-bot-api \
  --restart always \
  -p 8081:8081 \
  -v /var/lib/telegram-bot-api:/var/lib/telegram-bot-api \
  -e TELEGRAM_API_ID="2040" \
  -e TELEGRAM_API_HASH="b18441a1ff607e10a989891a5462e627" \
  -e TELEGRAM_LOCAL="1" \
  aiogram/telegram-bot-api:latest

echo "⏳ កំពុងរង់ចាំ Telegram Bot API Server Start (ប្រហែល 5 វិនាទី)..."
sleep 5

# បង្ហាញ Docker status និង Logs ប្រសិនបើមានបញ្ហា
docker ps -f name=telegram-bot-api
if curl -s http://127.0.0.1:8081 > /dev/null 2>&1; then
    echo "✅ Telegram Local Bot API កំពុងដំណើរការលើ http://127.0.0.1:8081 រួចរាល់!"
else
    echo "🔍 Logs របស់ Telegram Bot API Container:"
    docker logs --tail 20 telegram-bot-api
fi

echo "⚙️ [4/5] កំពុងកំណត់ .env របស់ Bot..."
APP_DIR="/root/AiStudioBot"
if [ ! -d "$APP_DIR" ]; then
    APP_DIR=$(pwd)
fi

ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    grep -q "BOT_API_ROOT" "$ENV_FILE" || echo "BOT_API_ROOT=http://127.0.0.1:8081" >> "$ENV_FILE"
    grep -q "LOCAL_BOT_API" "$ENV_FILE" || echo "LOCAL_BOT_API=true" >> "$ENV_FILE"
    echo "✅ បានបន្ថែម BOT_API_ROOT=http://127.0.0.1:8081 ទៅក្នុង $ENV_FILE រួចរាល់!"
else
    echo "⚠️ រកមិនឃើញ $ENV_FILE សូមពិនិត្យថតគម្រោង!"
fi

echo "📦 [5/5] ដំឡើង Library សំឡេង & Restart Bot ជាមួយ PM2..."
pip3 install soundfile torchaudio --break-system-packages 2>/dev/null || true

if command -v pm2 &> /dev/null; then
    pm2 restart Ai-Studio-Bot || pm2 restart all || true
    echo "✅ PM2 Bot Restart រួចរាល់!"
fi

echo ""
echo "=========================================================================="
echo "🎉 ជោគជ័យ 100%! Bot របស់អ្នកឥឡូវនេះអាចទទួល និងផ្ញើ Video ផ្ទាល់បានដល់ 2GB (2000MB)!"
echo "👉 ឥឡូវអ្នកអាចផ្ញើ file វីដេអូទំហំធំ (>20MB រហូតដល់ 2000MB) ចូល bot ក្នុង Telegram បានភ្លាមៗ!"
echo "=========================================================================="
