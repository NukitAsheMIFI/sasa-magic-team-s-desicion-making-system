#!/bin/bash
set -e

echo "=== Запуск сборки и развертывания SPR Comparison Tool ==="

# Сборка и запуск контейнера в фоновом режиме
docker compose up --build -d

echo "=== Контейнер запущен! ==="
echo "Приложение доступно по адресу: http://localhost:8000"

# script is ready