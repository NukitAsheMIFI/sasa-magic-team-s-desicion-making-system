from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from sqlalchemy.orm import Session
from database import get_db, SessionLocal # Импортируем фабрику сессий
import models, schemas
import datetime
import time

router = APIRouter()

# Имитация оркестратора пайплайна
def run_pipeline(run_id: int, config: dict):
    # ВАЖНО: Создаем НОВУЮ сессию для фонового процесса
    db = SessionLocal()
    try:
        run = db.query(models.Run).filter(models.Run.id == run_id).first()
        if not run:
            return
        run.status = "running"
        db.commit()

        steps = ["load", "normalize", "compare", "checks"]
        for step_name in steps:
            step = models.RunStep(run_id=run_id, name=step_name, status="pending")
            db.add(step)
        db.commit()

        # --- ИМИТАЦИЯ РАБОТЫ СКРИПТОВ ---
        for step_name in steps:
            step = db.query(models.RunStep).filter(
                models.RunStep.run_id == run_id, 
                models.RunStep.name == step_name
            ).first()
            
            step.status = "running"
            step.started_at = datetime.datetime.now().isoformat()
            db.commit()
            
            time.sleep(1) # Имитация тяжелой работы скрипта
            
            # Если это шаг сравнения — запишем фейковые данные в витрину
            if step_name == "compare":
                mock_rows = [
                    models.MartRow(run_id=run_id, app_id="I32554354", path="decisionResult.decision", 
                                   value_before="APPROVE", value_after="REJECT", diff_flag=1, change_type="VALUE_CHANGED"),
                    models.MartRow(run_id=run_id, app_id="I32554355", path="characteristics.score_okb", 
                                   value_before="750", value_after="750", diff_flag=0, change_type="SAME"),
                    models.MartRow(run_id=run_id, app_id="I32554358", path="decisionResult.scoring.new_model", 
                                   value_before=None, value_after="0.85", diff_flag=1, change_type="ATTRIBUTE_NEW")
                ]
                db.add_all(mock_rows)
                db.commit()

            step.status = "done"
            step.finished_at = datetime.datetime.now().isoformat()
            db.commit()

        run.status = "completed"
        db.commit()
        
    except Exception as e:
        print(f"Pipeline error: {e}")
        db.rollback()
        run = db.query(models.Run).filter(models.Run.id == run_id).first()
        if run:
            run.status = "failed"
            db.commit()
    finally:
        # Обязательно закрываем сессию
        db.close()

@router.post("/", response_model=schemas.RunResponse)
def create_run(run: schemas.RunCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    db_run = models.Run(
        user_id=run.user_id,
        config=run.config,
        status="pending",
        created_at=datetime.datetime.now().isoformat()
    )
    db.add(db_run)
    db.commit()
    db.refresh(db_run)
    
    # Передаем только ID и конфиг, без объекта db
    background_tasks.add_task(run_pipeline, db_run.id, run.config)
    
    return db_run

@router.get("/{run_id}/steps")
def get_run_steps(run_id: int, db: Session = Depends(get_db)):
    steps = db.query(models.RunStep).filter(models.RunStep.run_id == run_id).all()
    return steps

# ДОБАВЛЯЕМ ЭНДПОИНТ ДЛЯ ПРОВЕРКИ ВИТРИНЫ
@router.get("/{run_id}/mart")
def get_run_mart(run_id: int, db: Session = Depends(get_db)):
    """Эндпоинт для получения данных сводной таблицы (mock)"""
    rows = db.query(models.MartRow).filter(models.MartRow.run_id == run_id).all()
    return rows