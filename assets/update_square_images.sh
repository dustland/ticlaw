#!/bin/bash
BASE_IMAGE="/Users/hugh/.gemini/antigravity/brain/936e6fda-08a4-4523-be28-c8103734390a/base_crab_icon_1772540169446.png"
cd /Users/hugh/dustland/aquaclaw/assets

sips -z 1024 1024 "$BASE_IMAGE" --out aquaclaw-favicon.png
sips -z 1024 1024 "$BASE_IMAGE" --out aquaclaw-icon.png
sips -s format jpeg -s formatOptions 100 -z 1024 1024 "$BASE_IMAGE" --out aquaclaw-sales.png
sips -s format jpeg -s formatOptions 100 -z 4096 4096 "$BASE_IMAGE" --out aquaclaw-profile.jpeg
