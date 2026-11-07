import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

# Импорты моделей и роутеров бэкендера
from database import engine, Base
from api import runs, reports
from database import engine
import models
from api import runs, reports, auth

Base.metadata.create_all(bind=engine)

app = FastAPI(title="SPR Comparison System")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Подключение роутов API
app.include_router(runs.router, prefix="/api")
app.include_router(reports.router, prefix="/api")
app.include_router(runs.router, prefix="/api/runs", tags=["runs"])
app.include_router(reports.router, prefix="/api/reports", tags=["reports"])
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])

@app.get("/api/health")
def health_check():
    return {"status": "ok", "message": "Бэкенд запущен"}

# ==========================================
# Раздача собранного React-фронтенда
# ==========================================
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

if os.path.exists(STATIC_DIR):
    # Раздаем ассеты фронтенда (js, css, картинки)
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    # Любой другой путь отдаем в index.html (для поддержки React Router)
    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        file_path = os.path.join(STATIC_DIR, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))