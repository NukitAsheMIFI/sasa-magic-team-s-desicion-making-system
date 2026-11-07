# ==========================================
# ЭТАП 1: Сборка фронтенда (Node.js + React)
# ==========================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Копируем зависимости фронтенда из src/frontend
COPY src/frontend/package*.json ./
RUN npm install

# Копируем исходники фронтенда и собираем dist
COPY src/frontend/ ./
RUN npm run build

# ==========================================
# ЭТАП 2: Подготовка бэкенда (Python + FastAPI)
# ==========================================
FROM python:3.11-slim AS final

WORKDIR /app
ENV PYTHONPATH="/app/src/backend:/app"

# Системные пакеты
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Зависимости Python
COPY src/backend/requirements.txt ./src/backend/
RUN pip install --no-cache-dir -r ./src/backend/requirements.txt

# Копируем исходники бэкенда, проверок и скриптов
COPY src/backend/ ./src/backend/
COPY src/checks/ ./src/checks/
COPY src/data/ ./src/data/

# Копируем собранный фронтенд в статику бэкенда
COPY --from=frontend-builder /app/frontend/dist ./src/backend/static

EXPOSE 8000

# Создаем тестового пользователя и стартуем сервер
CMD ["sh", "-c", "python src/backend/seed.py && uvicorn src.backend.main:app --host 0.0.0.0 --port 8000"]