import sys
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session
from sqlalchemy import func, literal
from database import SQLALCHEMY_DATABASE_URL
from database import get_db
import models

# Инициализация роутера
router = APIRouter()

# --- НАСТРОЙКА ПУТЕЙ ДЛЯ МОДУЛЯ АНАЛИТИКА ---
# Делаем это один раз при старте, чтобы не пихать sys.path.append в каждую функцию
current_file = Path(__file__).resolve()
src_dir = current_file.parent.parent.parent
analytics_dir = src_dir / "analytics"
if str(analytics_dir) not in sys.path:
    sys.path.append(str(analytics_dir))
# ---------------------------------------------


# 1. СВОДНАЯ ТАБЛИЦА (Pivot Facts)
@router.get("/{run_id}/pivot-facts")
def get_pivot_facts(run_id: int, db: Session = Depends(get_db)):
    facts = db.query(models.PivotFact).filter(models.PivotFact.run_id == run_id).all()
    
    return [
        {
            "PREFIX": f.prefix, "CLASS": f.class_name, "SUFFIX": f.suffix,
            "ARRAY_KEY": f.array_key, "KEY": f.key, "VALUE_ADJUSTED": f.value_adjusted,
            "DIFF_FLAG": str(f.diff_flag), "SOURCE": f.source, "CNT": f.cnt
        } for f in facts
    ]


# 2. РЕЕСТР ЗАЯВОК (Applications Registry)
@router.get("/{run_id}/applications")
def get_applications(run_id: int, db: Session = Depends(get_db)):
    try:
        # Ищем заявки с изменениями (лимит 100)
        results = db.query(
            models.MartRow.app_id,
            func.count(models.MartRow.id).label("diff_count")
        ).filter(
            models.MartRow.run_id == run_id,
            models.MartRow.diff_flag == 1
        ).group_by(models.MartRow.app_id).limit(100).all()

        if not results:
            return []

        app_ids = [r.app_id for r in results]

        # Достаем решения BEFORE и AFTER
        decisions = db.query(
            models.MartRow.app_id, 
            models.MartRow.value_before,
            models.MartRow.value_after
        ).filter(
            models.MartRow.run_id == run_id,
            models.MartRow.app_id.in_(app_ids),
            models.MartRow.key == "decision"
        ).all()

        # Словарь: { 'I32554354': ('APPROVE', 'REJECT') }
        decision_map = {d.app_id: (d.value_before, d.value_after) for d in decisions}

        response = []
        for r in results:
            dec_b, dec_a = decision_map.get(r.app_id, (None, None))
            
            # Очистка от NaN и None
            if dec_b is None or str(dec_b).lower() == 'nan': dec_b = "UNKNOWN"
            if dec_a is None or str(dec_a).lower() == 'nan': dec_a = "UNKNOWN"
                
            response.append({
                "app_id": str(r.app_id),
                "diff_count": int(r.diff_count),
                "beforeDecision": str(dec_b),   # Для фронтендера
                "afterDecision": str(dec_a)     # Для фронтендера
            })
        return response
        
    except Exception as e:
        print(f"ERROR in get_applications: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# 3. ДОСЬЕ ЗАЯВКИ (Drill-down)
@router.get("/{run_id}/applications/{app_id}/diff")
def get_app_diff(run_id: int, app_id: str, db: Session = Depends(get_db)):
    rows = db.query(models.MartRow).filter(
        models.MartRow.run_id == run_id,
        models.MartRow.app_id == app_id
    ).all()

    def get_comment(row):
        if row.change_type == "VALUE_CHANGED": return "значение изменилось"
        if row.change_type == "ATTRIBUTE_NEW": return "атрибут добавился в AFTER"
        if row.change_type == "ATTRIBUTE_LOST": return "атрибут пропал в AFTER"
        return ""

    return [
        {
            "APP_ID": r.app_id, "PREFIX": r.prefix, "CLASS": r.class_name, 
            "SUFFIX": r.suffix, "ARRAY_KEY": r.array_key, "KEY": r.key,
            "VALUE_BEFORE": r.value_before, "VALUE_AFTER": r.value_after,
            "ADJUSTED_BEFORE": r.adjusted_before, "ADJUSTED_AFTER": r.adjusted_after,
            "DIFF_FLAG": r.diff_flag, "COMMENT": get_comment(r)
        } for r in rows
    ]


# 4. ОТЧЕТ ПРОВЕРОК (Checks)
@router.get("/{run_id}/checks")
def get_checks(run_id: int, db: Session = Depends(get_db)):
    checks = db.query(models.CheckResult).filter(models.CheckResult.run_id == run_id).all()
    return checks


# 5. БИЗНЕС-ВЕРДИКТ (Verdict)
@router.get("/{run_id}/verdict")
def get_verdict(run_id: int, db: Session = Depends(get_db)):
    v = db.query(models.Verdict).filter(models.Verdict.run_id == run_id).first()
    if not v:
        return {}
    return {
        "total_apps": v.total_apps,
        "ar_before": v.ar_before,
        "ar_after": v.ar_after,
        "new_approved": v.new_approved,
        "lost_approved": v.lost_approved,
        "net_impact": v.net_impact,
        "summary": v.summary
    }


# В reports.py
@router.get("/{run_id}/export.html", response_class=HTMLResponse)
def export_html_report(run_id: int):
    try:
        # Импорт внутри функции (чтобы сервер не падал, если файла нет)
        from html_generator import generate_html_report
        
        # Получаем абсолютный путь к БД из настроек бэкенда
        # (SQLALCHEMY_DATABASE_URL выглядит как "sqlite:///C:/path/to/hackathon.db")
        db_path = SQLALCHEMY_DATABASE_URL.replace("sqlite:///", "")
        
        # Передаем run_id и путь к БД в генератор аналитика
        html_content = generate_html_report(run_id, db_path=db_path)
        
        return HTMLResponse(content=html_content)
    except ImportError:
        return HTMLResponse(content="<h1>Ошибка: Генератор HTML (html_generator.py) еще не создан аналитиком</h1>", status_code=500)
    except Exception as e:
        return HTMLResponse(content=f"<h1>Ошибка генерации отчета: {e}</h1>", status_code=500)

@router.get("/{run_id}/ai-summary")
def get_ai_summary(run_id: int, db: Session = Depends(get_db)):
    try:
        # Импортируем функцию аналитика (путь уже настроен в начале файла)
        from ai_summary import generate_executive_summary

        # 1. Достаем бизнес-вердикт из БД
        v = db.query(models.Verdict).filter(models.Verdict.run_id == run_id).first()
        if not v:
            return {"status": "error", "summary": "Вердикт не найден. Дождитесь окончания пайплайна."}
        
        verdict_dict = {
            "total_apps": v.total_apps,
            "ar_before": v.ar_before,
            "ar_after": v.ar_after,
            "net_impact": v.net_impact,
            "new_approved": v.new_approved,
            "lost_approved": v.lost_approved
        }

        # 2. Достаем проверки из БД
        checks = db.query(models.CheckResult).filter(models.CheckResult.run_id == run_id).all()
        
        # Конвертируем в формат, который ожидает аналитик (с БОЛЬШИМИ буквами)
        checks_list = []
        for c in checks:
            checks_list.append({
                "RESULT": c.result,
                "LABEL": c.label,
                "ARGUMENT": c.argument,
                "CNT": c.cnt
            })

        # 3. Вызываем генератор ИИ-мнения
        ai_result = generate_executive_summary(verdict_dict, checks_list)
        return ai_result

    except ImportError:
        return {"status": "error", "summary": "Модуль ai_summary.py не найден в папке analytics."}
    except Exception as e:
        return {"status": "error", "summary": f"Ошибка генерации ИИ-мнения: {e}"}