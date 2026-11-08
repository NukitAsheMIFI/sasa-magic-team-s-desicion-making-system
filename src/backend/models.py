from sqlalchemy import Column, Integer, String, Float, ForeignKey, JSON
from sqlalchemy.orm import relationship
from database import Base

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)

class Run(Base):
    __tablename__ = "runs"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    status = Column(String, default="pending") # pending, running, completed, failed
    config = Column(JSON) # Храним пути, скрипты, настройки
    created_at = Column(String) 
    
    steps = relationship("RunStep", back_populates="run")
    mart_rows = relationship("MartRow", back_populates="run")

class RunStep(Base):
    __tablename__ = "run_steps"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("runs.id"))
    name = Column(String) # load, normalize, union, checks
    status = Column(String, default="pending") # pending, running, done, failed
    started_at = Column(String, nullable=True)
    finished_at = Column(String, nullable=True)
    logs = Column(String, nullable=True) # Ошибки или логи скрипта
    code_ref = Column(String, nullable=True) # Ссылка на скрипт (для журнала)
    
    run = relationship("Run", back_populates="steps")

class MartRow(Base):
    __tablename__ = "mart_rows"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("runs.id"), index=True)
    app_id = Column(String, index=True)
    path = Column(String, index=True)
    array_key = Column(String, nullable=True, index=True)
    
    prefix = Column(String, index=True)
    class_name = Column(String, index=True)
    suffix = Column(String, nullable=True)
    key = Column(String, index=True)
    
    value_before = Column(String, nullable=True)
    value_after = Column(String, nullable=True)
    adjusted_before = Column(String, nullable=True)
    adjusted_after = Column(String, nullable=True)
    
    diff_flag = Column(Integer, default=0, index=True)
    change_type = Column(String, index=True)
    
    run = relationship("Run", back_populates="mart_rows")

class PivotFact(Base):
    __tablename__ = "pivot_facts"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("runs.id"), index=True)
    prefix = Column(String, index=True)
    class_name = Column(String, index=True)
    suffix = Column(String, nullable=True)
    array_key = Column(String, nullable=True)
    key = Column(String, index=True)
    value_adjusted = Column(String)
    diff_flag = Column(Integer)
    source = Column(String) # BEFORE (MASTER) / AFTER (BETA)
    cnt = Column(Integer)

class CheckResult(Base):
    __tablename__ = "check_results"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("runs.id"), index=True)
    
    label = Column(String)       # Название проверки (LABEL)
    source = Column(String)      # BEFORE / AFTER
    argument = Column(String)    # Предмет проверки (ARGUMENT)
    cnt = Column(Integer)        # Сколько заявок (CNT)
    total = Column(Integer)      # База (TOTAL)
    metric = Column(Float)       # Метрика (METRIC)
    result = Column(String)      # PASS / FAIL
    confidence = Column(String)  # HIGH / LOW
    app_ids = Column(JSON)       # Список ID заявок (сохраняем как JSON)

class Segment(Base):
    __tablename__ = "segments"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("runs.id"), index=True)
    app_id = Column(String, index=True)
    
    decision_before = Column(String, nullable=True)
    decision_after = Column(String, nullable=True)
    decision_changed = Column(Integer, default=0)
    
    products = Column(String, nullable=True)
    pd_model_before = Column(String, nullable=True)
    pd_model_after = Column(String, nullable=True)
    cutoff_before = Column(String, nullable=True)
    cutoff_after = Column(String, nullable=True)

class Verdict(Base):
    __tablename__ = "verdicts"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("runs.id"), index=True)
    total_apps = Column(Integer)
    ar_before = Column(Float)
    ar_after = Column(Float)
    new_approved = Column(Integer)
    lost_approved = Column(Integer)
    net_impact = Column(Integer)
    summary = Column(String)