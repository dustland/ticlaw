#!/bin/bash
BASE_IMAGE="./ticlaw-base.png"
cd "$(dirname "$0")"

sips -z 1024 1024 "$BASE_IMAGE" --out ticlaw-favicon.png
sips -z 1024 1024 "$BASE_IMAGE" --out ticlaw-icon.png
sips -s format jpeg -s formatOptions 100 -z 1024 1024 "$BASE_IMAGE" --out ticlaw-sales.png
sips -s format jpeg -s formatOptions 100 -z 4096 4096 "$BASE_IMAGE" --out ticlaw-profile.jpeg
