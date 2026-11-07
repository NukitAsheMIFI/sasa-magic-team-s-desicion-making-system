from database import SessionLocal
import models

def create_mock_user():
    db = SessionLocal()
    try:
        # Проверяем, нет ли уже такого пользователя
        existing_user = db.query(models.User).filter(models.User.id == 1).first()
        if existing_user:
            print("Пользователь с id=1 уже существует.")
            return

        # Создаем пользователя с явным id=1
        user = models.User(id=1, username="test_analyst")
        db.add(user)
        db.commit()
        print("✅ Mock-пользователь успешно создан (id=1, username=test_analyst)")
    except Exception as e:
        print(f"❌ Ошибка: {e}")
        db.rollback()
    finally:
        db.close()

if __name__ == "__main__":
    create_mock_user()