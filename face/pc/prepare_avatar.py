# Builds LiveTalking's wav2lip avatar folder from the original HELPER portrait.
# coords.pkl entries are (y1, y2, x1, x2), the order paste_back_frame reads.
# The portrait is an illustration. This does not download or copy anyone's likeness.
import argparse
import json
import os
import pickle
import sys

FRAMES = 8


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--livetalking', required=True)
    p.add_argument('--png', required=True)
    p.add_argument('--box', required=True)
    p.add_argument('--avatar', default='helper')
    args = p.parse_args()
    try:
        from PIL import Image
    except ImportError:
        print('HELPER_FACE pillow is not installed (pip install pillow)', flush=True)
        return 2
    with open(args.box, encoding='utf-8') as f:
        box = json.load(f)
    y1, y2, x1, x2 = (int(box['y1']), int(box['y2']), int(box['x1']), int(box['x2']))
    resample = Image.Resampling.LANCZOS if hasattr(Image, 'Resampling') else Image.LANCZOS
    image = Image.open(args.png).convert('RGB')
    if image.size != (256, 256):
        image = image.resize((256, 256), resample)
    w, h = image.size
    if not (0 <= x1 < x2 <= w and 0 <= y1 < y2 <= h):
        print('HELPER_FACE box is outside the portrait', flush=True)
        return 2
    face = image.crop((x1, y1, x2, y2)).resize((256, 256), resample)
    root = os.path.join(args.livetalking, 'data', 'avatars', args.avatar)
    full = os.path.join(root, 'full_imgs')
    faces = os.path.join(root, 'face_imgs')
    os.makedirs(full, exist_ok=True)
    os.makedirs(faces, exist_ok=True)
    coords = []
    for i in range(FRAMES):
        name = f'{i:08d}.png'
        image.save(os.path.join(full, name))
        face.save(os.path.join(faces, name))
        coords.append((y1, y2, x1, x2))
    with open(os.path.join(root, 'coords.pkl'), 'wb') as f:
        pickle.dump(coords, f)
    print(f'HELPER_FACE avatar {root}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
