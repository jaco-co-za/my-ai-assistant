from __future__ import annotations

import os
import subprocess
import threading
import webbrowser
from pathlib import Path

import pystray
import requests
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
LOGS_DIR = ROOT / "logs"
PORT = int(os.getenv("WHISPER_PORT", "3221"))

state = {
    "health": "Unknown",
    "detail": "",
}
stop_event = threading.Event()


def get_health_state() -> tuple[str, str]:
    try:
        response = requests.get(f"http://localhost:{PORT}/health", timeout=1.5)
        if response.ok:
            payload = response.json()
            model = payload.get("model", "?")
            device = payload.get("device", "?")
            return "Healthy", f"{model} on {device}"
        return "Unhealthy", f"HTTP {response.status_code}"
    except Exception as exc:
        return "Offline", str(exc)


def create_image(health_state: str) -> Image.Image:
    size = 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if health_state == "Healthy":
        color = (34, 197, 94, 255)
    elif health_state == "Unhealthy":
        color = (234, 179, 8, 255)
    else:
        color = (239, 68, 68, 255)

    draw.rounded_rectangle((8, 8, 56, 56), radius=14, fill=(31, 41, 55, 255))
    draw.ellipse((20, 20, 44, 44), fill=color)
    return image


def refresh(icon: pystray.Icon) -> None:
    health_state, detail = get_health_state()
    state["health"] = health_state
    state["detail"] = detail

    icon.icon = create_image(health_state)
    icon.title = f"Whisper API: {health_state}"
    icon.update_menu()


def poll_loop(icon: pystray.Icon) -> None:
    while not stop_event.wait(5):
        refresh(icon)


def open_health(_icon: pystray.Icon, _item: pystray.MenuItem) -> None:
    webbrowser.open(f"http://localhost:{PORT}/health")


def open_logs(_icon: pystray.Icon, _item: pystray.MenuItem) -> None:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(["explorer", str(LOGS_DIR)])


def quit_app(icon: pystray.Icon, _item: pystray.MenuItem) -> None:
    stop_event.set()
    icon.stop()


def health_line(_item: pystray.MenuItem) -> str:
    return f"API: {state['health']} ({state['detail']})"


def main() -> None:
    icon = pystray.Icon(
        "whisper_api",
        create_image("Unknown"),
        "Whisper API",
        menu=pystray.Menu(
            pystray.MenuItem(health_line, None, enabled=False),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Open Health Endpoint", open_health),
            pystray.MenuItem("Open Logs Folder", open_logs),
            pystray.MenuItem("Exit", quit_app),
        ),
    )

    refresh(icon)
    thread = threading.Thread(target=poll_loop, args=(icon,), daemon=True)
    thread.start()
    icon.run()


if __name__ == "__main__":
    main()
