const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Инициализация базы данных
const db = new sqlite3.Database('./tabs.db', (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
    } else {
        console.log('Подключение к SQLite базе установлено');
        initDatabase();
    }
});

// Создание таблиц
function initDatabase() {
    db.run(`CREATE TABLE IF NOT EXISTS tabs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tab_id INTEGER NOT NULL,
        rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
        user_ip TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tab_id) REFERENCES tabs (id) ON DELETE CASCADE,
        UNIQUE(tab_id, user_ip)
    )`);

    // Добавляем начальные данные, если таблица пуста
    db.get("SELECT COUNT(*) as count FROM tabs", (err, row) => {
        if (row.count === 0) {
            const initialTabs = [
                {
                    title: "Nothing Else Matters",
                    artist: "Metallica",
                    content: "e|-------0-------0-------0-------0-------|\nB|-----1-----1-----1-----1-----1-----1---|\nG|---0-----0-----0-----0-----0-----0-----|\nD|---------------------------------------|\nA|---------------------------------------|\nE|-3-----3-----3-----3-----3-----3-------|"
                },
                {
                    title: "Wish You Were Here",
                    artist: "Pink Floyd",
                    content: "e|-------0-------0-------0-------0-------|\nB|-----0-----0-----0-----0-----0-----0---|\nG|---1-----1-----1-----1-----1-----1-----|\nD|-2-----2-----2-----2-----2-----2-------|\nA|---------------------------------------|\nE|---------------------------------------|"
                },
                {
                    title: "Stairway to Heaven",
                    artist: "Led Zeppelin",
                    content: "e|-------5-------7-------8-------7-------|\nB|-----5-----5-----5-----5-----5-----5---|\nG|---5-----5-----5-----5-----5-----5-----|\nD|---------------------------------------|\nA|---------------------------------------|\nE|---------------------------------------|"
                }
            ];

            const stmt = db.prepare("INSERT INTO tabs (title, artist, content) VALUES (?, ?, ?)");
            initialTabs.forEach(tab => {
                stmt.run([tab.title, tab.artist, tab.content]);
            });
            stmt.finalize();
            console.log('Добавлены начальные данные');
        }
    });
}

// API Routes

// Получить все табы
app.get('/api/tabs', (req, res) => {
    const search = req.query.search;
    
    let query = `
        SELECT t.*, 
               COALESCE(AVG(r.rating), 0) as rating,
               COUNT(r.rating) as votes
        FROM tabs t
        LEFT JOIN ratings r ON t.id = r.tab_id
    `;
    
    let params = [];
    
    if (search) {
        query += ` WHERE t.title LIKE ? OR t.artist LIKE ?`;
        params = [`%${search}%`, `%${search}%`];
    }
    
    query += ` GROUP BY t.id ORDER BY t.created_at DESC`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(rows);
    });
});

// Получить конкретный таб
app.get('/api/tabs/:id', (req, res) => {
    const id = req.params.id;
    
    db.get(`
        SELECT t.*, 
               COALESCE(AVG(r.rating), 0) as rating,
               COUNT(r.rating) as votes
        FROM tabs t
        LEFT JOIN ratings r ON t.id = r.tab_id
        WHERE t.id = ?
        GROUP BY t.id
    `, [id], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!row) {
            res.status(404).json({ error: 'Таб не найден' });
            return;
        }
        res.json(row);
    });
});

// Добавить новый таб
app.post('/api/tabs', (req, res) => {
    const { title, artist, content } = req.body;
    
    if (!title || !artist || !content) {
        res.status(400).json({ error: 'Все поля обязательны для заполнения' });
        return;
    }
    
    db.run(
        "INSERT INTO tabs (title, artist, content) VALUES (?, ?, ?)",
        [title, artist, content],
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            res.json({ 
                id: this.lastID,
                message: 'Таб успешно добавлен'
            });
        }
    );
});

// Оценить таб
app.post('/api/tabs/:id/rate', (req, res) => {
    const tabId = req.params.id;
    const { rating, user_ip } = req.body;
    
    if (!rating || rating < 1 || rating > 5) {
        res.status(400).json({ error: 'Рейтинг должен быть от 1 до 5' });
        return;
    }
    
    // Проверяем существование таба
    db.get("SELECT id FROM tabs WHERE id = ?", [tabId], (err, tab) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!tab) {
            res.status(404).json({ error: 'Таб не найден' });
            return;
        }
        
        // Проверяем, не оценивал ли уже пользователь этот таб
        if (user_ip) {
            db.get(
                "SELECT id FROM ratings WHERE tab_id = ? AND user_ip = ?",
                [tabId, user_ip],
                (err, existingRating) => {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }
                    
                    if (existingRating) {
                        res.status(400).json({ error: 'Вы уже оценили этот таб' });
                        return;
                    }
                    
                    insertRating();
                }
            );
        } else {
            insertRating();
        }
    });
    
    function insertRating() {
        db.run(
            "INSERT INTO ratings (tab_id, rating, user_ip) VALUES (?, ?, ?)",
            [tabId, rating, user_ip || null],
            function(err) {
                if (err) {
                    res.status(500).json({ error: err.message });
                    return;
                }
                
                // Получаем обновленный рейтинг
                db.get(`
                    SELECT 
                        COALESCE(AVG(rating), 0) as new_rating,
                        COUNT(rating) as votes
                    FROM ratings 
                    WHERE tab_id = ?
                `, [tabId], (err, result) => {
                    if (err) {
                        res.status(500).json({ error: err.message });
                        return;
                    }
                    
                    res.json({
                        message: 'Рейтинг успешно добавлен',
                        new_rating: parseFloat(result.new_rating).toFixed(1),
                        votes: result.votes
                    });
                });
            }
        );
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Откройте http://localhost:${PORT} в браузере`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('Закрытие соединения с БД');
        process.exit(0);
    });
});
