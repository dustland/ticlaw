#!/bin/bash
HORIZ_IMAGE="/Users/hugh/.gemini/antigravity/brain/936e6fda-08a4-4523-be28-c8103734390a/horizontal_logo_1772540217561.png"
cd /Users/hugh/dustland/aquaclaw/assets

sips -c 252 1024 "$HORIZ_IMAGE" --out aquaclaw-logo-dark.png
sips -c 319 1024 "$HORIZ_IMAGE" --out aquaclaw-logo.png

# For social preview, we need 1456x720, so resize width to 1456 and crop height.
cp "$HORIZ_IMAGE" temp_social.png
sips -z 1456 1456 temp_social.png
sips -c 720 1456 -s format jpeg -s formatOptions 100 temp_social.png --out social-preview.jpg
rm temp_social.png

