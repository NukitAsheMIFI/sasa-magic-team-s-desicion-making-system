from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from sqlalchemy.orm import Session
from database import get_db
import models, schemas
from services.runner import execute_python_script
import datetime
import time

router = APIRouter()

# Эмуляция оркестратора пайплайна (будет вызываться в фоне)
def run_pipeline(run_id: int, db: Session, config: dict):
    try:
        # 1. Обновляем статус
        run = db.query(models.Run).filter(models.Run.id == run_id).first()
        run.status = "running"
        db.commit()

        # 2. Создаем шаги
        steps = ["load", "normalize", "compare", "checks"]
        for step_name in steps:
            step = models.RunStep(run_id=run_id, name=step_name, status="pending")
            db.add(step)
        db.commit()

        # 3. ПОШАГОВОЕ ВЫПОЛНЕНИЕ
        # (В реальности здесь будет вызов execute_python_script для каждого этапа)
        
        # Имитация работы (заглушка для теста API)
        for step_name in steps:
            step = db.query(models.RunStep).filter(
                models.RunStep.run_id == run_id, 
                models.RunStep.name == step_name
            ).first()
            
            step.status = "running"
            db.commit()
            
            time.sleep(1) # Имитация тяжелой работы
            
            step.status = "done"
            db.commit()

        # 4. Завершение
        run.status = "completed"
        db.commit()
        
    except Exception as e:
        run = db.query(models.Run).filter(models.Run.id == run_id).first()
        run.status = "failed"
        db.commit()

@router.post("/", response_model=schemas.RunResponse)
def create_run(run: schemas.RunCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    # cоздаем запись о запуске в БД
    db_run = models.Run(
        user_id=run.user_id,
        config=run.config,
        status="pending",
        created_at=datetime.datetime.now().isoformat()
    )
    db.add(db_run)
    db.commit()
    db.refresh(db_run)
    
    # oтправляем в фон
    background_tasks.add_task(run_pipeline, db_run.id, db, run.config)
    
    return db_run

@router.get("/{run_id}/steps")
def get_run_steps(run_id: int, db: Session = Depends(get_db)):
    steps = db.query(models.RunStep).filter(models.RunStep.run_id == run_id).all()
    return steps