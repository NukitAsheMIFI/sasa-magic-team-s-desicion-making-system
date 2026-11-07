from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func, literal
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