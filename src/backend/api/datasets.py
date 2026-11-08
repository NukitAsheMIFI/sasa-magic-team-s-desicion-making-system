import os
import shutil
from pathlib import Path
from fastapi import APIRouter, File, UploadFile, Form, HTTPException

router = APIRouter()

# Папка, куда будем складывать загруженные датасеты
BASE_UPLOAD_DIR = Path("uploads").resolve()
BASE_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

@router.post("/")
async def upload_dataset(
    dataset_name: str = Form(...),
    before: list[UploadFile] = File(...),
    after: list[UploadFile] = File(...)
):
    # Очищаем имя от спецсимволов (защита от взлома путей)
    safe_name = "".join(c for c in dataset_name if c.isalnum() or c in ("-", "_"))
    if not safe_name:
        raise HTTPException(status_code=400, detail="Недопустимое имя датасета")

    dataset_dir = BASE_UPLOAD_DIR / safe_name
    before_dir = dataset_dir / "before"
    after_dir = dataset_dir / "after"

    # Создаем папки (если уже есть - ок, перезапишем)
    before_dir.mkdir(parents=True, exist_ok=True)
    after_dir.mkdir(parents=True, exist_ok=True)

    # Сохраняем файлы BEFORE
    for file in before:
        file_path = before_dir / file.filename
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

    # Сохраняем файлы AFTER
    for file in after:
        file_path = after_dir / file.filename
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

    return {
        "datasetName": safe_name,
        "before_dir": str(before_dir),
        "after_dir": str(after_dir),
        "sourceDir": str(dataset_dir),
        "message": f"Успешно загружено {len(before)} файлов BEFORE и {len(after)} файлов AFTER"
    }