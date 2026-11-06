# ==========================================
# ЭТАП 1: Сборка фронтенда (Node.js + React)
# ==========================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# Копируем зависимости фронтенда и устанавливаем их
COPY frontend/package*.json ./
RUN npm install

# Копируем исходный код фронтенда и собираем проект в папку dist
COPY frontend/ ./
RUN npm run build

# ==========================================
# ЭТАП 2: Подготовка бэкенда (Python + FastAPI)
# ==========================================
FROM python:3.11-slim AS final

WORKDIR /app

# Установка базовых утилит
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Установка зависимостей Python
COPY backend/requirements.txt ./backend/
RUN pip install --no-cache-dir -r ./backend/requirements.txt

# Копируем бэкенд, скрипты и проверки
COPY backend/ ./backend/
COPY scripts/ ./scripts/
COPY checks/ ./checks/

# Копируем собранный фронтенд из первого этапа в папку бэкенда
COPY --from=frontend-builder /app/frontend/dist ./backend/static

EXPOSE 8000

# Запуск приложения через uvicorn
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]