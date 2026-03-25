import M5
from M5 import *
from hardware import *
import requests as urequests
import time
import struct
import math

# 修改为你的服务端地址
SERVER_BASE = "http://YOUR_SERVER_IP:5000"
SERVER_URL = SERVER_BASE + "/chat"
PENDING_URL = SERVER_BASE + "/pending/"
DEVICE_ID = "cores3"
SAMPLE_RATE = 16000
CHUNK_SEC = 0.5
CHUNK_SIZE = int(SAMPLE_RATE * 2 * CHUNK_SEC)
SILENCE_THRESHOLD = 500
SILENCE_CHUNKS = 4
MAX_CHUNKS = 20
is_busy = False

def make_wav_header(data_len, sample_rate=16000, channels=1, bits=16):
  byte_rate = sample_rate * channels * bits // 8
  block_align = channels * bits // 8
  header = struct.pack('<4sI4s4sIHHIIHH4sI',
    b'RIFF', 36 + data_len, b'WAVE',
    b'fmt ', 16, 1, channels, sample_rate,
    byte_rate, block_align, bits,
    b'data', data_len)
  return header

def rms(buf):
  n = len(buf) // 2
  if n == 0:
    return 0
  total = 0
  for i in range(0, len(buf), 2):
    val = struct.unpack_from('<h', buf, i)[0]
    total += val * val
  return int(math.sqrt(total / n))

def draw_status(text):
  Widgets.fillScreen(0x222222)
  Widgets.Label(text, 40, 100, 2, 0xffffff, 0x222222, Widgets.FONTS.DejaVu18)

def record_and_send():
  global is_busy
  is_busy = True
  draw_status("Listening...")
  Mic.begin()
  chunks = []
  silent = 0
  started = False
  for i in range(MAX_CHUNKS):
    buf = bytearray(CHUNK_SIZE)
    Mic.record(buf, SAMPLE_RATE)
    time.sleep(CHUNK_SEC + 0.05)
    level = rms(buf)
    if level > SILENCE_THRESHOLD:
      started = True
      silent = 0
      chunks.append(bytes(buf))
    elif started:
      chunks.append(bytes(buf))
      silent += 1
      if silent >= SILENCE_CHUNKS:
        break
  Mic.end()
  if not chunks:
    draw_status("No speech")
    time.sleep(1)
    draw_status("Touch to talk")
    is_busy = False
    return
  draw_status("Sending...")
  audio = b''.join(chunks)
  wav = make_wav_header(len(audio)) + audio
  resp = urequests.post(SERVER_URL, data=wav, headers={"X-Device-Id": DEVICE_ID})
  if resp.status_code != 200:
    print("err:", resp.text)
    resp.close()
    draw_status("Error!")
    time.sleep(2)
    draw_status("Touch to talk")
    is_busy = False
    return
  data = resp.content
  resp.close()
  print("WAV size:", len(data))
  draw_status("Playing...")
  play_wav(data)
  draw_status("Touch to talk")
  time.sleep(2)
  while M5.Touch.getCount() > 0:
    M5.update()
    time.sleep(0.1)
  is_busy = False

last_poll = 0
POLL_INTERVAL = 3

def play_wav(data):
  with open("/flash/response.wav", "wb") as f:
    f.write(data)
  Speaker.begin()
  Speaker.setVolumePercentage(0.6)
  Speaker.playWavFile("/flash/response.wav")
  while Speaker.isPlaying():
    time.sleep(0.1)
  Speaker.end()

def check_pending():
  global is_busy
  resp = urequests.get(PENDING_URL + DEVICE_ID)
  if resp.status_code == 204:
    resp.close()
    return
  is_busy = True
  data = resp.content
  resp.close()
  print("Push WAV size:", len(data))
  draw_status("Broadcast...")
  play_wav(data)
  draw_status("Touch to talk")
  is_busy = False

def setup():
  M5.begin()
  Widgets.setRotation(1)
  draw_status("Touch to talk")

def loop():
  global last_poll
  M5.update()
  if not is_busy and M5.Touch.getCount() > 0:
    record_and_send()
  now = time.time()
  if not is_busy and now - last_poll > POLL_INTERVAL:
    last_poll = now
    check_pending()

if __name__ == '__main__':
  setup()
  while True:
    loop()
