#!/bin/bash
HORIZ_IMAGE="./ticlaw-logo-base.png"
cd "$(dirname "$0")"

sips -c 252 1024 "$HORIZ_IMAGE" --out ticlaw-logo-dark.png
sips -c 319 1024 "$HORIZ_IMAGE" --out ticlaw-logo.png

# For social preview, we need 1456x720, so resize width to 1456 and crop height.
cp "$HORIZ_IMAGE" temp_social.png
sips -z 1456 1456 temp_social.png
sips -c 720 1456 -s format jpeg -s formatOptions 100 temp_social.png --out social-preview.jpg
rm temp_social.png

