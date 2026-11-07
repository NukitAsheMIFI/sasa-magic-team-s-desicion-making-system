from pydantic import BaseModel
from typing import Optional, Dict, Any
from datetime import datetime


class RunCreate(BaseModel):
    user_id: int
    config: Dict[str, Any] 


class RunResponse(BaseModel):
    id: int
    status: str
    created_at: Optional[str] = None 
    
    class Config:
        from_attributes = True

class StepResponse(BaseModel):
    id: int
    name: str
    status: str
    logs: Optional[str] = None
    
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    code_ref: Optional[str] = None # ссылка на скрипт
    
    class Config:
        from_attributes = True
class UserLogin(BaseModel):
    username: str

class UserResponse(BaseModel):
    id: int
    username: str

    class Config:
        from_attributes = True