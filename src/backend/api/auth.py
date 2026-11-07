from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from database import get_db
import models, schemas

router = APIRouter()

@router.post("/login", response_model=schemas.UserResponse)
def login(user_data: schemas.UserLogin, db: Session = Depends(get_db)):
    # Ищем пользователя по имени
    user = db.query(models.User).filter(models.User.username == user_data.username).first()
    
    # Если нет — создаем нового (автоматическая регистрация при первом входе)
    if not user:
        user = models.User(username=user_data.username)
        db.add(user)
        db.commit()
        db.refresh(user)
        
    return user