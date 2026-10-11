#!/bin/bash
cd "$(dirname "$0")"

echo "╔══════════════════════════════════════╗"
echo "║         ✦ OmniChat - Iniciando       ║"
echo "╚══════════════════════════════════════╝"
echo ""

if [ ! -f ".env" ]; then
  echo "⚠️  Arquivo .env não encontrado!"
  echo "   Copiando .env.example → .env"
  cp .env.example .env
  echo "   ➡  Edite o arquivo .env com suas chaves de API"
  echo ""
fi

echo "🚀 Iniciando servidor..."
echo ""
node server.js
