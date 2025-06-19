from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn
import websockets
import asyncio
import json
import ssl
import datetime
from typing import List, Dict, Set

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# Модель для POST-запроса
class URLModel(BaseModel):
    url: str 
    url_2: str

# Глобальные переменные
active_connections: Set[WebSocket] = set()
ws_connections: Dict[str, websockets.WebSocketClientProtocol] = {}
connection_tasks: List[asyncio.Task] = []
url_to_team_mapping: Dict[str, str] = {}
combined_players_by_team: Dict[str, List[dict]] = {}
connection_status: Dict[str, str] = {}
player_speeds_by_tag = {}
player_hr_by_tag = {}
player_speed_120s_by_tag = {}
player_speed_180s_by_tag = {}


@app.get("/", response_class=HTMLResponse)
async def get_index():
    return open("static/index.html", encoding="utf-8").read()

@app.post("/set_wss_url")
async def set_wss_url(payload: URLModel):
    global connection_tasks, ws_connections, url_to_team_mapping, combined_players_by_team

    # Закрываем старые сессии
    for task in connection_tasks:
        task.cancel()
    for conn in ws_connections.values():
        await conn.close()
    
    connection_tasks = []
    ws_connections = {}
    url_to_team_mapping = {}
    combined_players_by_team = {}
    connection_status = {}


    if payload.url:
        url_to_team_mapping[payload.url] = "team1"
    if payload.url_2:
        url_to_team_mapping[payload.url_2] = "team2"
    

    for url in [payload.url, payload.url_2]:
        if url:
            task = asyncio.create_task(connect_to_external_ws(url))
            connection_tasks.append(task)
    
    return {"status": "success", "message": f"Подключено к {len(url_to_team_mapping)} серверам"}


@app.get("/status")
async def get_status():
    return {
        "connected_urls": list(url_to_team_mapping.keys()),
        "team_mapping": url_to_team_mapping,
        "status_by_url": connection_status
    }


async def connect_to_external_ws(url: str):
    team = url_to_team_mapping.get(url, "Unknown")
    max_wait_seconds = 300  # 5 минут
    first_fail_time = None

    while True:
        try:
            ssl_context = ssl._create_unverified_context()
            async with websockets.connect(url, ssl=ssl_context) as ws:
                ws_connections[team] = ws
                print(f"✅ Подключено к {url} ({team})")

                first_fail_time = None  # Сброс таймера после успеха

                while True:
                    data = await ws.recv()
                    processed_data = process_data(data, url, team)

                    if processed_data.get("status") == "success" and processed_data.get("players"):
                        combined_players_by_team[team] = processed_data["players"]

                        all_players = []
                        for plist in combined_players_by_team.values():
                            all_players.extend(plist)

                        response = {
                            "status": "success",
                            "players": all_players,
                            "timestamp": datetime.datetime.now().isoformat()
                        }

                        for connection in active_connections.copy():
                            try:
                                await connection.send_json(response)
                            except:
                                active_connections.discard(connection)
        except Exception as e:
            print(f"❌ Ошибка подключения к {url}: {e}. Переподключение через 5 сек...")

            if first_fail_time is None:
                first_fail_time = datetime.datetime.now()
            else:
                elapsed = (datetime.datetime.now() - first_fail_time).total_seconds()
                if elapsed > max_wait_seconds:
                    print(f"🛑 Истекло время ожидания подключения к {url}. Отключаемся.")
                    response = {
                        "status": "disconnected_timeout",
                        "team": team,
                        "message": f"Автоматическое отключение {team} после 5 минут безуспешных попыток подключения.",
                        "timestamp": datetime.datetime.now().isoformat()
                    }
                    for connection in active_connections.copy():
                        try:
                            await connection.send_json(response)
                        except:
                            active_connections.discard(connection)
                    return 

            response = {
                "status": "no_response",
                "team": team,
                "message": f"Нет ответа от источника {team}",
                "timestamp": datetime.datetime.now().isoformat()
            }

            for connection in active_connections.copy():
                try:
                    await connection.send_json(response)
                except:
                    active_connections.discard(connection)

            await asyncio.sleep(5)

def calc_max_speed(tag: str, speed_60s: float) -> float:
    prev = player_speeds_by_tag.get(tag, 0)
    if (speed_60s > 34.6):
        return prev
    else:
        new_max = max(prev, speed_60s)
        player_speeds_by_tag[tag] = new_max
        return new_max

def calc_max_hr(tag: str, hr: float) -> float:
    prev = player_hr_by_tag.get(tag, 0)
    if (hr > 213):
        return prev
    else:
        new_max = max(prev, hr)
        player_hr_by_tag[tag] = new_max
        return new_max

async def delayed_speed_update(tag: str, speed: float, delay: int, storage: dict):
    await asyncio.sleep(delay)
    storage[tag] = speed


def process_data(raw_data: str, source_url: str, team: str) -> dict:
    try:
        data = json.loads(raw_data)
        
        if data.get("kind") == "sensors" and isinstance(data.get("payload"), list):
            players = []
            for player in data["payload"]:
                if player.get("player_info"):
                    
                    tag = player["tag"]
                    max_speed_60_s = round(player["online_data"].get("max_speed_60_s", 0) * 3.6, 1)

                    # Запускаем задачи с задержкой 120 и 180 сек
                    asyncio.create_task(delayed_speed_update(tag, max_speed_60_s, 60, player_speed_120s_by_tag))
                    asyncio.create_task(delayed_speed_update(tag, max_speed_60_s, 120, player_speed_180s_by_tag))

                    players.append({
                        "tag": tag,
                        "team_name": player["team_name"],
                        "jersey": player["player_info"].get("jersey"),
                        "first_name": player["player_info"].get("f_name"),
                        "last_name": player["player_info"].get("l_name"),
                        "distance_m": round(player["online_data"].get("distance", 0)),
                        "distance_km": round(player["online_data"].get("distance", 0)/1000, 1),
                        "hir": round(
                            player["online_data"].get("speed_z_4_dist", 0) +
                            player["online_data"].get("speed_z_5_dist", 0), 1
                        ),
                        "hr": round(player["online_data"].get("hr", 0)),
                        "max_hr": calc_max_hr(tag, round(player["online_data"].get("hr", 0))),
                        "max_speed_60_s": max_speed_60_s,
                        "max_speed_120_s": player_speed_120s_by_tag.get(tag, 0),
                        "max_speed_180_s": player_speed_180s_by_tag.get(tag, 0),
                        "max_speed": calc_max_speed(tag, max_speed_60_s),
                        "load": round(player["online_data"].get("load", 0), 1),
                    })

            return {
                "status": "success",
                "team": team,
                "source_url": source_url,
                "players": players,
                "timestamp": datetime.datetime.now().isoformat()
            }

        return {
            "status": "success",
            "team": team,
            "source_url": source_url,
            "message": "Not a sensors data",
            "original_data": data
        }

    except json.JSONDecodeError:
        return {
            "status": "error",
            "team": team,
            "source_url": source_url,
            "message": "Invalid JSON data"
        }
    except Exception as e:
        return {
            "status": "error",
            "team": team,
            "source_url": source_url,
            "message": str(e)
        }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_connections.add(websocket)
    
    try:
        while True:
            data = await websocket.receive_text()
            if data == 'disconnect':
                await websocket.close()
                return
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        active_connections.remove(websocket)

@app.post("/disconnect_all")
async def disconnect_all():
    global connection_tasks, ws_connections, url_to_team_mapping
    
    # Отключаем все соединения
    for task in connection_tasks:
        task.cancel()
    for conn in ws_connections.values():
        await conn.close()
    
    player_speeds_by_tag.clear()
    player_hr_by_tag.clear()

    connection_tasks = []
    ws_connections = {}
    url_to_team_mapping = {}
    
    return {"status": "success", "message": "Все соединения закрыты"}


@app.post("/reset_max_values")
async def reset_max_values():
    player_speeds_by_tag.clear()
    player_hr_by_tag.clear()
    return {"status": "success", "message": "Максимальные значения скорости и пульса очищены"}

class ResetTagRequest(BaseModel):
    tag: int

@app.post("/reset_max_values_tag")
async def reset_max_values(req: ResetTagRequest):
    tag = req.tag
    if tag in player_speeds_by_tag:
        player_speeds_by_tag.pop(tag, None)
    if tag in player_hr_by_tag:
        player_hr_by_tag.pop(tag, None)
    return {"status": "success", "message": f"Максимальные значения очищены для {tag}"}

if __name__ == "__main__":
    uvicorn.run("index:app", host="0.0.0.0", port=8000, reload=True)