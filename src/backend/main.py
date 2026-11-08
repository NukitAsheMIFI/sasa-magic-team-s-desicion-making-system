from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import engine
import models
from api import runs, reports, auth, datasets

# Создаем таблицы
models.Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Strategy Diff Studio API",
    description="Backend for testing decision engine strategy changes",
    version="0.1.0"
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Для MVP разрешаем всё
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(runs.router, prefix="/api/runs", tags=["runs"])
app.include_router(reports.router, prefix="/api/reports", tags=["reports"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(datasets.router, prefix="/api/datasets", tags=["datasets"])

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Strategy Diff API is running"}