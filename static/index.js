const BASE_PATH = "/socket"; // /socket

let socket = null;
let teamData = {};  // Храним данные по командам в объекте
const urlToTeamMap = new Map();

// Кэш для хранения текущих подключений сервера
let serverConnections = {
    team1: { connected: false, url: null },
    team2: { connected: false, url: null }
};

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('connectBtn').addEventListener('click', connectHandler);
    initPage();  // Инициализация страницы

    document.getElementById('disconnectBtn').addEventListener('click', disconnectHandler);

    async function disconnectHandler() {
        try {
            const response = await fetch(`${BASE_PATH}/disconnect_all`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (response.ok) {
                updateStatus('Все соединения отключены', 'disconnected');
                updateConnectionInfo();
                // Очищаем таблицу
                document.getElementById('teamTableBody').innerHTML = '';
                // Очищаем localStorage
                localStorage.removeItem('wssUrl1');
                localStorage.removeItem('wssUrl2');
                // Очищаем поля ввода
                document.getElementById('wssUrl').ariaPlaceholder = '';
                document.getElementById('wssUrl_2').ariaPlaceholder = '';
            } else {
                throw new Error(await response.text() || 'Ошибка сервера');
            }
        } catch (error) {
            console.error('Ошибка отключения:', error);
            updateStatus('Ошибка отключения: ' + error.message, 'disconnected');
        }
    }

    document.getElementById('resetMaxBtn').addEventListener('click', async () => {
        try {
            const response = await fetch(`${BASE_PATH}/reset_max_values`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
    
            if (response.ok) {
                // 1. Сохраняем текущий статус
                const statusElement = document.getElementById('status');
                const previousText = statusElement.textContent;
                const previousClass = statusElement.className;
    
                // 2. Показываем временное сообщение
                updateStatus('Максимальные значения очищены', 'connected');
    
                // 3. Возвращаем старое сообщение через 5 секунд
                setTimeout(() => {
                    updateStatus(previousText, previousClass);
                }, 3000);
            } else {
                throw new Error(await response.text() || 'Ошибка сброса');
            }
        } catch (error) {
            console.error('Ошибка сброса:', error);
            updateStatus('Ошибка сброса: ' + error.message, 'disconnected');
        }
    });

});



async function initPage() {
    // Восстановление URL из localStorage если они есть
    const savedUrl1 = localStorage.getItem('wssUrl1');
    const savedUrl2 = localStorage.getItem('wssUrl2');
    
    if (savedUrl1) document.getElementById('wssUrl').value = savedUrl1;
    if (savedUrl2) document.getElementById('wssUrl_2').value = savedUrl2;

    await fetchStatus();  // Проверим текущие подключения на сервере
    initWebSocket();     // Инициализируем WebSocket соединение
    
    // Если есть активные подключения, запросим данные
    if (serverConnections.team1.connected || serverConnections.team2.connected) {
        requestInitialData();
    }
}

async function connectHandler() {
    const url1 = document.getElementById('wssUrl').value.trim();
    const url2 = document.getElementById('wssUrl_2').value.trim();


    if (!url1 && !url2) {
        alert('Введите хотя бы один URL');
        return;
    }

    // Сохраняем URL в localStorage
    if (url1) localStorage.setItem('wssUrl1', url1);
    if (url2) localStorage.setItem('wssUrl2', url2);

    teamData = {};
    urlToTeamMap.clear();

    if (url1) urlToTeamMap.set(url1, 'Team 1');
    if (url2) urlToTeamMap.set(url2, 'Team 2');

    try {
        const response = await fetch(`${BASE_PATH}/set_wss_url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                url: url1,
                url_2: url2 
            })
        });

        if (response.ok) {
            await fetchStatus(); // Обновим статус подключений
            updateStatus('Подключение установлено', 'connected');
            
            // Если WebSocket еще не инициализирован
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                initWebSocket();
            }
        } else {
            throw new Error(await response.text() || 'Ошибка сервера');
        }
    } catch (error) {
        updateStatus('Ошибка подключения: ' + error.message, 'disconnected');
        console.error('Ошибка:', error);
    }
}

function initWebSocket() {
    if (socket) socket.close();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}${BASE_PATH}/ws`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log('WebSocket connected');
        updateStatus('Подключено', 'connected');
        updateConnectionInfo(); // Обновим информацию о подключениях
        
        // Если есть активные подключения, запросим данные
        if (serverConnections.team1.connected || serverConnections.team2.connected) {
            requestInitialData();
        }
    };

    socket.onmessage = (event) => {
        handleSocketMessage(event);
        updateConnectionInfo(); // Обновим информацию после получения данных
    };

    socket.onclose = () => {
        console.log('WebSocket disconnected');
        updateStatus('Соединение закрыто', 'disconnected');
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('Ошибка соединения', 'disconnected');
    };
}

function handleSocketMessage(event) {
    try {
        const data = JSON.parse(event.data);

        // Обработка сообщений о статусе подключения
        if (data.type === 'connection_status') {
            updateServerConnections(data.data);
            return;
        }

        if (data.status === 'no_response') {
            console.log(`⚠️ Нет ответа от ${data.team}: ${data.message}`);
            updateStatus(`Нет данных от ${data.team}`, 'disconnected');
            return;
        }

        if (data.status === 'disconnected_timeout') {
            console.log(`⚠️ Время подключения к ${data.team} истекло: ${data.message}`);
            updateStatus(`Время подключения к ${data.team} истекло`, 'disconnected');
            return;
        }

        if (data.status === 'success' && data.players) {
            const teamName = data.team || data.players[0]?.team_name;

            if (!teamName) return;

            teamData[teamName] = data.players;
            renderTable();
        }
    } catch (e) {
        console.error('Ошибка обработки сообщения:', e);
    }
}

// Обновляем информацию о серверных подключениях
function updateServerConnections(statusData) {
    serverConnections = {
        team1: {
            connected: statusData.team1,
            url: urlToTeamMap.size > 0 ? [...urlToTeamMap.keys()][0] : null
        },
        team2: {
            connected: statusData.team2,
            url: urlToTeamMap.size > 1 ? [...urlToTeamMap.keys()][1] : null
        }
    };
    updateConnectionInfo();
}

// Отображаем информацию о подключениях
function updateConnectionInfo() {
    const infoBox = document.getElementById('connectionInfo');
    if (!infoBox) return;

    const connections = [];
    
    if (serverConnections.team1.connected && serverConnections.team1.url) {
        connections.push(`Team 1: ${serverConnections.team1.url}`);
    }
    
    if (serverConnections.team2.connected && serverConnections.team2.url) {
        connections.push(`Team 2: ${serverConnections.team2.url}`);
    }

    infoBox.textContent = connections.length > 0 
        ? `Активные подключения сервера: ${connections.join(' | ')}` 
        : 'Нет активных подключений к внешним WebSocket';
    
    // Обновляем состояние кнопок
    const isConnected = connections.length > 0;
    document.getElementById('connectBtn').disabled = isConnected;
    document.getElementById('disconnectBtn').disabled = !isConnected;
}

// Запрос начальных данных при загрузке страницы
function requestInitialData() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'get_initial_data' }));
    }
}

// Проверка текущего статуса серверных подключений
async function fetchStatus() {
    try {
        const res = await fetch(`${BASE_PATH}/status`);
        if (!res.ok) throw new Error('Не удалось получить статус');

        const data = await res.json();
        serverConnections = {
            team1: {
                connected: data.team1?.connected || false,
                url: data.team1?.url || null
            },
            team2: {
                connected: data.team2?.connected || false,
                url: data.team2?.url || null
            }
        };
        
        updateConnectionInfo();
        return data;
    } catch (err) {
        console.error('Ошибка получения статуса:', err);
        return null;
    }
}


function renderTable() {
    const allPlayers = Object.values(teamData).flat();

    const sortedPlayers = allPlayers.sort((a, b) =>
        a.team_name.localeCompare(b.team_name)
    );

    const tableBody = document.getElementById('teamTableBody');
    const fragment = document.createDocumentFragment();

    sortedPlayers.forEach(player => {
        const row = document.createElement('tr');

        // Стандартные столбцы
        ['tag', 'team_name', 'jersey', 'first_name', 'last_name', 'distance_m', 'distance_km', 'hir', 'hr', 'max_hr', 'max_speed_60_s', 'max_speed_120_s', 'max_speed_180_s', 'max_speed', 'load'].forEach(field => {
            const cell = document.createElement('td');
            cell.textContent = player[field] ?? '-';
            row.appendChild(cell);
        });

        // Кнопка сброса для конкретного игрока
        const buttonCell = document.createElement('td');
        const button = document.createElement('button');
        button.textContent = 'Сбросить';
        button.classList.add('reset');

        button.addEventListener('click', async () => {
            console.log(player.tag)
            try {
                const response = await fetch(`${BASE_PATH}/reset_max_values_tag`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ tag: player.tag }) 
                });

                if (response.ok) {
                    const statusElement = document.getElementById('status');
                    const previousText = statusElement.textContent;
                    const previousClass = statusElement.className;

                    updateStatus(`Максимальные значения очищены для ${player.tag}`, 'connected');

                    setTimeout(() => {
                        updateStatus(previousText, previousClass);
                    }, 3000);
                } else {
                    throw new Error(await response.text() || 'Ошибка сброса');
                }
            } catch (error) {
                console.error('Ошибка сброса:', error);
                updateStatus('Ошибка сброса: ' + error.message, 'disconnected');
            }
        });

        buttonCell.appendChild(button);
        row.appendChild(buttonCell);

        fragment.appendChild(row);
    });

    tableBody.innerHTML = '';
    tableBody.appendChild(fragment);
}

function updateStatus(text, className) {
    const statusElement = document.getElementById('status');
    if (statusElement) {
        statusElement.textContent = text;
        statusElement.className = className;
    }
}
