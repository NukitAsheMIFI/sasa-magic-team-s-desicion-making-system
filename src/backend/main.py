from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import engine
import models
from api import runs # Импортируем наш роутер

# 1. Создаем таблицы в базе данных (если их еще нет)
models.Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Strategy Diff Studio API",
    description="Backend for testing decision engine strategy changes",
    version="0.1.0"
)

# 2. Настройка CORS (чтобы фронтенд с React мог стучаться)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Для MVP разрешаем всё
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 3. Подключаем роуты
app.include_router(runs.router, prefix="/api/runs", tags=["runs"])

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Strategy Diff API is running"}

@app.get("/health")
def health_check():
    return {"status": "healthy"}