# Local face service for the HELPER Windows PC. Listens on 127.0.0.1 only.
# The Node home bridge calls it with the PC_BRIDGE_SECRET bearer token and forwards JPEG
# frames to the VPS over the bridge that is already open. Nothing here accepts the public internet.
#
# When LiveTalking is installed (Apache-2.0) this process starts it on 127.0.0.1:8010, subscribes
# with aiortc, and posts the TTS audio to /humanaudio. Without the model, /health stays up and
# HELPER uses the in-browser face instead.
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIND = '127.0.0.1'
LT_PORT = int(os.environ.get('FACE_LT_PORT', '8010'))
MAX_BODY = 8_000_000
JPEG_MAX = 150_000

_frames = []
_seq = 0
_cond = threading.Condition()
_proc = None
_relay_session = None
_relay_error = ''
_talk_lock = threading.Lock()
_loop = None
_loop_ready = threading.Event()


def _gpu_name():
    if os.environ.get('HELPER_FACE_NO_GPU') == '1':
        return ''
    try:
        out = subprocess.run(
            ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
            capture_output=True, text=True, timeout=4,
        )
        line = (out.stdout or '').strip().splitlines()
        return line[0][:80] if line else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def _livetalking_dir():
    root = os.environ.get('HELPER_LIVETALKING_DIR', '')
    if root and os.path.isfile(os.path.join(root, 'app.py')):
        return root
    return ''


def _avatar_ready(root):
    avatar = os.environ.get('FACE_AVATAR', 'helper')
    base = os.path.join(root, 'data', 'avatars', avatar)
    return os.path.isfile(os.path.join(base, 'coords.pkl')) and os.path.isdir(os.path.join(base, 'full_imgs'))


def _model_ready(root):
    return os.path.isfile(os.path.join(root, 'models', 'wav2lip.pth'))


def _port_open(port):
    try:
        with socket.create_connection((BIND, port), 0.3):
            return True
    except OSError:
        return False


def _ensure_livetalking():
    global _proc
    if os.environ.get('HELPER_FACE_NO_GPU') == '1':
        return False
    root = _livetalking_dir()
    if not root or not _avatar_ready(root) or not _model_ready(root):
        return False
    if _port_open(LT_PORT):
        return True
    if _proc is not None and _proc.poll() is None:
        return False
    python = os.environ.get('FACE_PYTHON') or sys.executable
    here = os.path.dirname(os.path.abspath(__file__))
    log_dir = os.environ.get('HELPER_FACE_STATE') or os.path.join(os.path.expanduser('~'), 'AppData', 'Local', 'HelperFace')
    try:
        os.makedirs(log_dir, exist_ok=True)
        log = open(os.path.join(log_dir, 'livetalking.log'), 'ab')
    except OSError:
        log = subprocess.DEVNULL
    env = os.environ.copy()
    env['HELPER_LIVETALKING_DIR'] = root
    _proc = subprocess.Popen([python, os.path.join(here, 'run_livetalking.py')], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
    return False


def status():
    root = _livetalking_dir()
    ready = bool(root and _avatar_ready(root) and _model_ready(root) and _port_open(LT_PORT))
    starting = bool(root and _avatar_ready(root) and _model_ready(root) and not ready and _proc is not None and _proc.poll() is None)
    relay = True
    try:
        import aiortc  # noqa: F401
        import cv2  # noqa: F401
    except ImportError:
        relay = False
    if os.environ.get('HELPER_FACE_NO_GPU') == '1':
        relay = False
    engine = 'livetalking' if ready and relay else ('starting' if starting else 'unavailable')
    return {
        'ok': True,
        'running': bool(ready and relay),
        'engine': engine,
        'relay': bool(relay),
        'avatar': bool(root and _avatar_ready(root)),
        'model': bool(root and _model_ready(root)),
        'gpu': _gpu_name(),
        'error': _relay_error,
    }


def publish(jpeg, sid):
    global _seq
    if not jpeg or len(jpeg) > JPEG_MAX:
        return
    with _cond:
        global_seq = _seq + 1
        _seq = global_seq
        _frames.append({'seq': global_seq, 'sid': sid, 'jpeg': base64.b64encode(jpeg).decode('ascii')})
        if len(_frames) > 24:
            del _frames[:-24]
        _cond.notify_all()


def frames_since(since, timeout=2.0):
    end = time.time() + timeout
    with _cond:
        while True:
            got = [f for f in _frames if f['seq'] > since]
            if got or time.time() >= end:
                return got
            _cond.wait(max(0.05, end - time.time()))


def _to_wav(data, mime):
    if data[:4] == b'RIFF' or (mime and 'wav' in mime):
        return data
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        return None
    try:
        proc = subprocess.run(
            [ffmpeg, '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
            input=data, capture_output=True, timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0 or not proc.stdout.startswith(b'RIFF'):
        return None
    return proc.stdout


def _post_json(path, payload):
    req = urllib.request.Request(
        f'http://{BIND}:{LT_PORT}{path}',
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read().decode() or '{}')


def _post_audio(sessionid, wav):
    boundary = '----helperface' + uuid.uuid4().hex
    head = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="sessionid"\r\n\r\n{sessionid}\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n'
    ).encode()
    tail = f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(
        f'http://{BIND}:{LT_PORT}/humanaudio',
        data=head + wav + tail,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
    )
    with urllib.request.urlopen(req, timeout=20) as res:
        return json.loads(res.read().decode() or '{}')


def _drive(sessionid, audio, mime, text):
    if audio:
        wav = _to_wav(audio, mime)
        if not wav:
            return {'ok': False, 'error': 'ffmpeg'}
        body = _post_audio(sessionid, wav)
        if body.get('code') not in (0, None) and body.get('code') != 0:
            return {'ok': False, 'error': str(body.get('msg') or 'audio')[:200]}
        return {'ok': True, 'sessionid': sessionid}
    if text:
        body = _post_json('/human', {'sessionid': sessionid, 'type': 'echo', 'text': text[:800], 'interrupt': True})
        if body.get('code') not in (0, None):
            return {'ok': False, 'error': str(body.get('msg') or 'text')[:200]}
        return {'ok': True, 'sessionid': sessionid}
    return {'ok': False, 'error': 'empty'}


async def _consume_video(track, sid):
    import cv2
    next_at = 0.0
    try:
        while True:
            frame = await track.recv()
            now = time.monotonic()
            if now < next_at:
                continue
            next_at = now + (1 / 12)
            img = frame.to_ndarray(format='bgr24')
            h, w = img.shape[:2]
            if w > 480:
                img = cv2.resize(img, (480, max(1, int(h * 480 / w))))
            ok, buf = cv2.imencode('.jpg', img, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
            if ok:
                publish(buf.tobytes(), sid)
    except Exception:
        return


def _relay_loop():
    global _loop
    import asyncio
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    _loop.call_soon(_loop_ready.set)
    _loop.run_forever()


def _running_loop():
    global _loop
    if _loop is None:
        threading.Thread(target=_relay_loop, name='helper-face-relay', daemon=True).start()
        _loop_ready.wait(5)
    return _loop


async def _open_relay(sid):
    global _relay_session, _relay_error
    from aiortc import RTCPeerConnection, RTCSessionDescription
    pc = RTCPeerConnection()
    pc.addTransceiver('video', direction='recvonly')
    pc.addTransceiver('audio', direction='recvonly')

    @pc.on('track')
    def on_track(track):
        if track.kind == 'video':
            import asyncio
            asyncio.ensure_future(_consume_video(track, sid))

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    gathered = asyncio_wait_ice(pc)
    await gathered
    answer = _post_json('/offer', {'sdp': pc.localDescription.sdp, 'type': pc.localDescription.type})
    if 'sdp' not in answer:
        await pc.close()
        _relay_error = 'no answer'
        return None
    await pc.setRemoteDescription(RTCSessionDescription(sdp=answer['sdp'], type=answer.get('type') or 'answer'))
    _relay_session = {'pc': pc, 'id': str(answer.get('sessionid') or '')}
    _relay_error = ''
    return _relay_session['id']


def asyncio_wait_ice(pc):
    import asyncio
    done = asyncio.Event()

    @pc.on('icegatheringstatechange')
    def _on_state():
        if pc.iceGatheringState == 'complete':
            done.set()

    if pc.iceGatheringState == 'complete':
        done.set()

    async def wait():
        try:
            await asyncio.wait_for(done.wait(), 3)
        except asyncio.TimeoutError:
            pass

    return wait()


def talk(audio, mime, text, sid):
    global _relay_error, _relay_session
    if os.environ.get('HELPER_FACE_NO_GPU') == '1':
        return {'ok': False, 'error': 'unavailable', 'engine': 'unavailable'}
    root = _livetalking_dir()
    if not root or not _avatar_ready(root) or not _model_ready(root):
        return {'ok': False, 'error': 'model', 'engine': 'unavailable'}
    if not _port_open(LT_PORT):
        _ensure_livetalking()
        return {'ok': False, 'error': 'starting', 'engine': 'starting'}
    try:
        import aiortc  # noqa: F401
    except ImportError:
        return {'ok': False, 'error': 'aiortc', 'engine': 'unavailable'}
    with _talk_lock:
        import asyncio
        try:
            loop = _running_loop()
            sessionid = _relay_session['id'] if _relay_session and _relay_session.get('id') else None
            if not sessionid:
                sessionid = asyncio.run_coroutine_threadsafe(_open_relay(sid), loop).result(timeout=20)
            if not sessionid:
                return {'ok': False, 'error': _relay_error or 'relay'}
            return _drive(sessionid, audio, mime, text)
        except Exception as e:
            _relay_error = str(e)[:200]
            _relay_session = None
            return {'ok': False, 'error': _relay_error}


def signal(offer):
    if not isinstance(offer, dict):
        return {'ok': False, 'error': 'offer'}
    sdp = str(offer.get('sdp') or '')
    if len(sdp) < 20 or len(sdp) > 100000 or 'v=0' not in sdp:
        return {'ok': False, 'error': 'offer'}
    if not _port_open(LT_PORT):
        _ensure_livetalking()
        return {'ok': False, 'error': 'starting'}
    try:
        answer = _post_json('/offer', {'sdp': sdp, 'type': 'offer'})
    except Exception as e:
        return {'ok': False, 'error': str(e)[:200]}
    if 'sdp' not in answer:
        return {'ok': False, 'error': 'no answer'}
    return {'ok': True, 'sdp': answer['sdp'], 'type': answer.get('type') or 'answer', 'sessionid': str(answer.get('sessionid') or '')}


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        return

    def _authorized(self):
        import hmac
        got = self.headers.get('Authorization', '')
        if got.lower().startswith('bearer '):
            got = got[7:]
        a = got.encode()
        b = self.server.secret.encode()
        return len(a) == len(b) and hmac.compare_digest(a, b)

    def _send(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _body(self):
        try:
            n = int(self.headers.get('Content-Length', '0') or 0)
        except ValueError:
            n = 0
        if n < 0 or n > MAX_BODY:
            return None
        raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw.decode() or '{}')
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _guard(self):
        if not self._authorized():
            self._send(401, {'ok': False, 'error': 'unauthorized'})
            return False
        return True

    def do_GET(self):
        if not self._guard():
            return
        path = self.path.split('?', 1)[0]
        if path == '/health':
            if os.environ.get('HELPER_FACE_NO_GPU') != '1':
                _ensure_livetalking()
            self._send(200, status())
            return
        if path == '/frames':
            since = 0
            if '?' in self.path:
                for part in self.path.split('?', 1)[1].split('&'):
                    if part.startswith('since='):
                        try:
                            since = int(part.split('=', 1)[1])
                        except ValueError:
                            since = 0
            got = frames_since(since, 2.0)
            self._send(200, {'ok': True, 'frames': got, 'status': status()})
            return
        self._send(404, {'ok': False, 'error': 'not found'})

    def do_POST(self):
        if not self._guard():
            return
        path = self.path.split('?', 1)[0]
        body = self._body()
        if body is None:
            self._send(413, {'ok': False, 'error': 'body'})
            return
        if path == '/audio':
            raw = b''
            if body.get('audio'):
                try:
                    raw = base64.b64decode(str(body.get('audio')), validate=False)
                except (ValueError, TypeError):
                    self._send(400, {'ok': False, 'error': 'audio'})
                    return
                if len(raw) > 2 * 1024 * 1024:
                    self._send(413, {'ok': False, 'error': 'audio'})
                    return
            result = talk(raw, str(body.get('mime') or ''), str(body.get('text') or '')[:800], str(body.get('id') or '')[:40])
            self._send(200, result)
            return
        if path == '/signal':
            self._send(200, signal(body))
            return
        if path == '/close':
            global _relay_session
            sess = _relay_session
            _relay_session = None
            if sess and sess.get('pc'):
                try:
                    sess['pc'].close()
                except Exception:
                    pass
            self._send(200, {'ok': True})
            return
        self._send(404, {'ok': False, 'error': 'not found'})


def main():
    secret = os.environ.get('PC_BRIDGE_SECRET', '')
    if len(secret) < 8:
        print('HELPER_FACE missing PC_BRIDGE_SECRET', flush=True)
        return 2
    port = 8771
    if '--port' in sys.argv:
        port = int(sys.argv[sys.argv.index('--port') + 1])
    if port < 0 or port > 65535:
        return 2
    httpd = ThreadingHTTPServer((BIND, port), Handler)
    httpd.secret = secret
    host, actual = httpd.server_address
    if host != BIND:
        print('HELPER_FACE refused non-local bind', flush=True)
        return 2
    print(f'HELPER_FACE {host} {actual}', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
