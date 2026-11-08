from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from sqlalchemy.orm import Session
import pandas as pd
import json
from database import get_db, SessionLocal # Импортируем фабрику сессий
import models, schemas
import datetime
import time
from services.runner import execute_python_script
from pathlib import Path
import os
from sqlalchemy import func, literal

router = APIRouter()

import pandas as pd # Не забудь добавить этот импорт в самый верх файла
from services.runner import execute_python_script

def run_pipeline(run_id: int, config: dict):
    db = SessionLocal()
    try:
        run = db.query(models.Run).filter(models.Run.id == run_id).first()
        if not run:
            return
        run.status = "running"
        db.commit()

        steps = ["load", "normalize", "checks"]
        for step_name in steps:
            db.add(models.RunStep(run_id=run_id, name=step_name, status="pending"))
        db.commit()

        for step_name in steps:
            step = db.query(models.RunStep).filter(
                models.RunStep.run_id == run_id, 
                models.RunStep.name == step_name
            ).first()
            
            step.status = "running"
            step.started_at = datetime.datetime.now().isoformat()
            db.commit()
            
            if step_name == "normalize":
                script_path = "user_scripts/pipeline.py" 
                
                current_file = Path(__file__).resolve()
                
                # Находимся в src/backend/api/runs.py
                # Поднимаемся на 3 уровня вверх: api -> backend -> src
                src_dir = current_file.parent.parent.parent
                
                # Теперь приклеиваем "data", так как она лежит внутри src
                data_path = src_dir / "data" / "RUN-20260827-0001" / "RESULTS"
                
                print(f"\n!!! СТАРТ НОРМАЛИЗАЦИИ !!!")
                print(f"Ищем данные в: {data_path}")
                
                input_args = {
                    "run_id": run_id,
                    "before_dir": str(data_path / "BEFORE_MASTER"),
                    "after_dir": str(data_path / "AFTER_BETA")
                }
                
                # ВЫЗОВ СКРИПТА
                res = execute_python_script(script_path, input_args)
                
                if not res["success"]:
                    step.status = "failed"
                    step.logs = res["error"]
                    db.commit()
                    raise Exception(f"Pipeline failed: {res['error']}")
                
                # ЧТЕНИЕ CSV И ЗАПИСЬ В БД
                                # ЧТЕНИЕ CSV И ЗАПИСЬ В БД
                print("Чтение CSV и запись в БД...")
                df = pd.read_csv(res["out_file"], sep=';', encoding='utf-8-sig')
                
                # Убираем медленный iterrows, готовим список словарей
                # Это работает в 100 раз быстрее
                records = df.to_dict('records')
                rows_to_insert = []
                
                for row in records:
                    rows_to_insert.append(models.MartRow(
                        run_id=run_id,
                        app_id=str(row['APP_ID']),
                        path=str(row['PATH']),
                        array_key=str(row['ARRAY_KEY']) if pd.notna(row['ARRAY_KEY']) else None,
                        prefix=str(row['PREFIX']),
                        class_name=str(row['CLASS']),
                        suffix=str(row['SUFFIX']) if pd.notna(row['SUFFIX']) else None,
                        key=str(row['KEY']),
                        value_before=str(row['VALUE_BEFORE']) if pd.notna(row['VALUE_BEFORE']) else None,
                        value_after=str(row['VALUE_AFTER']) if pd.notna(row['VALUE_AFTER']) else None,
                        adjusted_before=str(row['ADJUSTED_BEFORE']) if pd.notna(row['ADJUSTED_BEFORE']) else None,
                        adjusted_after=str(row['ADJUSTED_AFTER']) if pd.notna(row['ADJUSTED_AFTER']) else None,
                        diff_flag=int(row['DIFF_FLAG']),
                        change_type=str(row['CHANGE_TYPE'])
                    ))
                    
                    if len(rows_to_insert) >= 10000:
                        db.bulk_save_objects(rows_to_insert)
                        db.commit()
                        rows_to_insert = []
                
                if rows_to_insert:
                    db.bulk_save_objects(rows_to_insert)
                    db.commit()
                print("Данные успешно загружены в БД!")
                
                print("Генерация фактов для сводной таблицы...")
                
                
                # 1. Считаем BEFORE
                q_before = db.query(
                    models.MartRow.prefix, models.MartRow.class_name, models.MartRow.suffix,
                    models.MartRow.array_key, models.MartRow.key, 
                    models.MartRow.adjusted_before.label("val_adj"),
                    models.MartRow.diff_flag, literal("BEFORE (MASTER)").label("source"),
                    func.count(models.MartRow.app_id).label("cnt")
                ).filter(models.MartRow.run_id == run_id).group_by(
                    models.MartRow.prefix, models.MartRow.class_name, models.MartRow.suffix,
                    models.MartRow.array_key, models.MartRow.key, models.MartRow.adjusted_before,
                    models.MartRow.diff_flag
                ).all()

                # 2. Считаем AFTER
                q_after = db.query(
                    models.MartRow.prefix, models.MartRow.class_name, models.MartRow.suffix,
                    models.MartRow.array_key, models.MartRow.key, 
                    models.MartRow.adjusted_after.label("val_adj"),
                    models.MartRow.diff_flag, literal("AFTER (BETA)").label("source"),
                    func.count(models.MartRow.app_id).label("cnt")
                ).filter(models.MartRow.run_id == run_id).group_by(
                    models.MartRow.prefix, models.MartRow.class_name, models.MartRow.suffix,
                    models.MartRow.array_key, models.MartRow.key, models.MartRow.adjusted_after,
                    models.MartRow.diff_flag
                ).all()

                # 3. Сохраняем в базу пачкой
                facts_to_insert = []
                for r in q_before + q_after:
                    if r.cnt > 0:
                        facts_to_insert.append(models.PivotFact(
                            run_id=run_id, prefix=r.prefix, class_name=r.class_name,
                            suffix=r.suffix, array_key=r.array_key, key=r.key,
                            value_adjusted=r.val_adj, diff_flag=r.diff_flag,
                            source=r.source, cnt=r.cnt
                        ))
                
                db.bulk_save_objects(facts_to_insert)
                db.commit()
                print("Факты для сводной таблицы успешно сгенерированы!")

                                # --- ЗАГРУЗКА СЕГМЕНТОВ ---
                import os
                print("Загрузка сегментов из segments.csv...")
                
                # Формируем путь к файлу (он лежит в той же папке temp/)
                seg_file = res["out_file"].replace(".csv", "_segments.csv")
                
                if os.path.exists(seg_file):
                    df_seg = pd.read_csv(seg_file, sep=';', encoding='utf-8-sig')
                    seg_records = df_seg.to_dict('records')
                    segments_to_insert = []
                    
                    for row in seg_records:
                        segments_to_insert.append(models.Segment(
                            run_id=run_id,
                            app_id=str(row.get('APP_ID')),
                            decision_before=str(row.get('DECISION_BEFORE')),
                            decision_after=str(row.get('DECISION_AFTER')),
                            decision_changed=int(row.get('DECISION_CHANGED', 0)),
                            products=str(row.get('PRODUCTS')),
                            pd_model_before=str(row.get('PD_MODEL_BEFORE')),
                            pd_model_after=str(row.get('PD_MODEL_AFTER')),
                            cutoff_before=str(row.get('CUTOFF_BEFORE')),
                            cutoff_after=str(row.get('CUTOFF_AFTER'))
                        ))
                    
                    db.bulk_save_objects(segments_to_insert)
                    db.commit()
                    print(f"Сегменты успешно загружены в БД! Строк: {len(segments_to_insert)}")
                else:
                    print("ВНИМАНИЕ: файл segments.csv не найден по пути", seg_file)
                # ---------------------------
                                # --- ЗАГРУЗКА БИЗНЕС-ВЕРДИКТА ---
                print("Загрузка бизнес-вердикта...")
                verdict_file = res["out_file"].replace(".csv", "_verdict.json")
                
                if os.path.exists(verdict_file):
                    with open(verdict_file, "r", encoding="utf-8") as vf:
                        v_data = json.load(vf)
                        
                        # Проверяем, нет ли уже вердикта для этого запуска (чтобы не было дублей)
                        existing_verdict = db.query(models.Verdict).filter(models.Verdict.run_id == run_id).first()
                        if not existing_verdict:
                            db_verdict = models.Verdict(
                                run_id=run_id,
                                total_apps=v_data.get("total_apps", 0),
                                ar_before=v_data.get("ar_before", 0.0),
                                ar_after=v_data.get("ar_after", 0.0),
                                new_approved=v_data.get("new_approved", 0),
                                lost_approved=v_data.get("lost_approved", 0),
                                net_impact=v_data.get("net_impact", 0),
                                summary=v_data.get("summary", "")
                            )
                            db.add(db_verdict)
                            db.commit()
                    print("Бизнес-вердикт успешно загружен в БД!")
                else:
                    print(f"ВНИМАНИЕ: файл вердикта не найден по пути {verdict_file}")
                # --------------------------------


            elif step_name == "checks":
                import sys
                import os
                
                # Подключаем папку analytics, чтобы импортировать оттуда модуль
                current_file = Path(__file__).resolve()
                src_dir = current_file.parent.parent.parent
                analytics_dir = src_dir / "analytics"
                if str(analytics_dir) not in sys.path:
                    sys.path.append(str(analytics_dir))
                
                try:
                    from checks_runner import run_all_checks
                    print("Запуск автоматических проверок...")
                    
                    # ВНИМАНИЕ: У нового скрипта аналитика нет параметров db и checks_dir, только run_id!
                    check_results = run_all_checks(run_id)
                    
                    # Сохраняем результаты в БД
                    checks_to_insert = []
                    for r in check_results:
                        checks_to_insert.append(models.CheckResult(
                            run_id=run_id,
                            label=r.get("LABEL", ""),
                            source=r.get("SOURCE", ""),
                            argument=r.get("ARGUMENT", ""),
                            cnt=r.get("CNT", 0),
                            total=r.get("TOTAL", 0),
                            metric=r.get("METRIC", 0.0),
                            result=r.get("RESULT", ""),
                            confidence=r.get("CONFIDENCE", ""),
                            app_ids=r.get("APP_IDS", [])
                        ))
                    
                    db.bulk_save_objects(checks_to_insert)
                    db.commit()
                    print(f"Проверки завершены. Сохранено строк: {len(checks_to_insert)}")
                    
                except Exception as e:
                    print(f"Ошибка при выполнении проверок: {e}")

            step.status = "done"
            step.logs = "Успешно выполнено"
            step.finished_at = datetime.datetime.now().isoformat()
            db.commit()

        run.status = "completed"
        db.commit()
        
    except Exception as e:
        print(f"Pipeline error: {e}")
        db.rollback()
        
        # 1. Помечаем сам запуск как проваленный
        run = db.query(models.Run).filter(models.Run.id == run_id).first()
        if run:
            run.status = "failed"
            db.commit()
            
        # 2. Ищем шаг, который завис в статусе running, и помечаем его как failed
        failed_step = db.query(models.RunStep).filter(
            models.RunStep.run_id == run_id, 
            models.RunStep.status == "running"
        ).first()
        
        if failed_step:
            failed_step.status = "failed"
            failed_step.logs = str(e) # Записываем текст ошибки в логи шага
            db.commit()

    finally:
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

@router.get("/")
def get_all_runs(db: Session = Depends(get_db)):
    runs = db.query(models.Run).order_by(models.Run.id.desc()).all()
    # Подмешиваем имя пользователя к каждому запуску
    result = []
    for r in runs:
        user = db.query(models.User).filter(models.User.id == r.user_id).first()
        result.append({
            "id": r.id,
            "status": r.status,
            "created_at": r.created_at,
            "user_id": r.user_id,
            "username": user.username if user else "Unknown"
        })
    return result