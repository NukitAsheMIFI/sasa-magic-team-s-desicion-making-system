from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func, literal, or_
from database import get_db
import models

router = APIRouter()

@router.get("/{run_id}/pivot-facts")
def get_pivot_facts(run_id: int, db: Session = Depends(get_db)):
    # Просто достаем готовые факты из базы! Это займет 0.01 секунды.
    facts = db.query(models.PivotFact).filter(models.PivotFact.run_id == run_id).all()
    
    return [
        {
            "PREFIX": f.prefix, "CLASS": f.class_name, "SUFFIX": f.suffix,
            "ARRAY_KEY": f.array_key, "KEY": f.key, "VALUE_ADJUSTED": f.value_adjusted,
            "DIFF_FLAG": str(f.diff_flag), "SOURCE": f.source, "CNT": f.cnt
        } for f in facts
    ]

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

@router.get("/{run_id}/checks")
def get_checks(run_id: int, db: Session = Depends(get_db)):
    """Отдаёт единый отчёт всех проверок"""
    checks = db.query(models.CheckResult).filter(models.CheckResult.run_id == run_id).all()
    return checks

from fastapi import HTTPException

@router.get("/{run_id}/applications")
def get_applications(run_id: int, db: Session = Depends(get_db)):
    try:
        # 1. Ищем заявки с изменениями (лимит 100)
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

        # 2. Достаем решения AFTER (ищем по key, как мы обсуждали)
        decisions = db.query(models.MartRow.app_id, models.MartRow.value_after).filter(
            models.MartRow.run_id == run_id,
            models.MartRow.app_id.in_(app_ids),
            models.MartRow.key == "decision"
        ).all()

        decision_map = {d.app_id: d.value_after for d in decisions}

        # 3. Формируем ответ, жестко приводя всё к строкам
        response = []
        for r in results:
            dec_after = decision_map.get(r.app_id)
            # Если пришел None или NaN, ставим UNKNOWN
            if dec_after is None or str(dec_after).lower() == 'nan':
                dec_after = "UNKNOWN"
                
            response.append({
                "app_id": str(r.app_id),
                "diff_count": int(r.diff_count),
                "decision_after": str(dec_after)
            })
        return response
    except Exception as e:
        print(f"ERROR in get_applications: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    
    # Делаем словарь для быстрого поиска: { 'I32554354': 'REJECT' }
    decision_map = {d.app_id: d.value_after for d in decisions}

    # 3. Собираем ответ в формате, который просил фронт
    return [
        {
            "app_id": r.app_id,
            "diff_count": r.diff_count,
            "decision_after": decision_map.get(r.app_id, "UNKNOWN")
        }
        for r in results
    ]