# Starts LiveTalking (Apache-2.0, https://github.com/lipku/LiveTalking) bound to 127.0.0.1 only.
# The HTTP API has no password of its own, so it must not listen on the LAN. WebRTC ICE can still
# use the PC's other addresses when FACE_WEBRTC=on; signaling stays on the HELPER bridge.
import os
import runpy
import sys

root = os.environ.get('HELPER_LIVETALKING_DIR', '')
if not root or not os.path.isfile(os.path.join(root, 'app.py')):
    print('HELPER_FACE livetalking dir is missing', flush=True)
    sys.exit(2)

os.chdir(root)
sys.path.insert(0, root)

import aiohttp.web as web  # noqa: E402

_TCPSite = web.TCPSite


class _LocalSite(_TCPSite):
    def __init__(self, runner, host=None, port=None, **kwargs):
        super().__init__(runner, '127.0.0.1', port, **kwargs)


web.TCPSite = _LocalSite

port = os.environ.get('FACE_LT_PORT', '8010')
model = os.environ.get('FACE_MODEL', 'wav2lip')
avatar = os.environ.get('FACE_AVATAR', 'helper')
sys.argv = [
    os.path.join(root, 'app.py'),
    '--transport', 'webrtc',
    '--model', model,
    '--avatar_id', avatar,
    '--listenport', port,
]
runpy.run_path(os.path.join(root, 'app.py'), run_name='__main__')
