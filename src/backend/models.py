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
    """Универсальная строка витрины. Бэкенд не знает, что такое PATH, он просто хранит строки."""
    __tablename__ = "mart_rows"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("runs.id"), index=True)
    app_id = Column(String, index=True)
    path = Column(String, index=True) # Например: characteristics.score_okb
    array_key = Column(String, nullable=True, index=True)
    value_before = Column(String, nullable=True)
    value_after = Column(String, nullable=True)
    diff_flag = Column(Integer, default=0, index=True)
    change_type = Column(String, index=True) # SAME, VALUE_CHANGED, ATTRIBUTE_NEW, ATTRIBUTE_LOST
    
    run = relationship("Run", back_populates="mart_rows")