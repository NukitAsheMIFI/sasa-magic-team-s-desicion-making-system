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

@router.get("/{run_id}/applications")
def get_applications_registry(
    run_id: int, 
    class_name: str = None, 
    value: str = None, 
    db: Session = Depends(get_db)
):
    """
    Возвращает реестр заявок для сводной таблицы.
    Поддерживает фильтрацию по CLASS и VALUE_ADJUSTED (если пользователь кликнул на ячейку).
    """
    
    # 1. Базовый запрос для получения всех уникальных заявок в прогоне
    query = db.query(models.MartRow.app_id).filter(models.MartRow.run_id == run_id).distinct()
    
    # 2. Применяем фильтры, если фронтендер их передал
    if class_name:
        # Ищем заявки, у которых в указанном классе (например, decisionResult) 
        # значение BEFORE или AFTER совпадает с тем, на что кликнули
        subquery = db.query(models.MartRow.app_id).filter(
            models.MartRow.run_id == run_id,
            models.MartRow.class_name == class_name,
            or_(
                models.MartRow.adjusted_before == value,
                models.MartRow.adjusted_after == value
            )
        ).distinct()
        query = query.filter(models.MartRow.app_id.in_(subquery))

    app_ids = [row[0] for row in query.all()]
    
    if not app_ids:
        return []

    # 3. Достаем количество изменений (diffCount) для каждой заявки
    diff_counts = db.query(
        models.MartRow.app_id, 
        func.count(models.MartRow.id).label('cnt')
    ).filter(
        models.MartRow.run_id == run_id,
        models.MartRow.app_id.in_(app_ids),
        models.MartRow.diff_flag == 1
    ).group_by(models.MartRow.app_id).all()
    
    diff_dict = {app_id: cnt for app_id, cnt in diff_counts}

    # 4. Достаем решения BEFORE и AFTER (для этого нужен PATH, который отвечает за решение)
    # В твоей нормализации это обычно "decisionResult.decision" или "decision"
    # Если аналитик назвал иначе, поменяй эту строчку:
    DECISION_PATH = "decisionResult.decision" 
    
    decisions = db.query(
        models.MartRow.app_id,
        models.MartRow.value_before,
        models.MartRow.value_after
    ).filter(
        models.MartRow.run_id == run_id,
        models.MartRow.path == DECISION_PATH,
        models.MartRow.app_id.in_(app_ids)
    ).all()

    decision_dict = {app_id: (vb, va) for app_id, vb, va in decisions}

    # 5. Собираем итоговый ответ в формате, который просил фронтендер
    result = []
    for app_id in app_ids:
        vb, va = decision_dict.get(app_id, (None, None))
        result.append({
            "id": f"APP-{app_id}", # Фронтендер просил префикс APP-
            "app_id": app_id,
            "beforeDecision": vb,
            "afterDecision": va,
            "diffCount": diff_dict.get(app_id, 0)
        })
        
    return result