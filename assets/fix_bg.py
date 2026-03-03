import sys
from PIL import Image

def get_base_bg(img):
    # Sample a few pixels from the center-ish area (but not on the logo)
    width, height = img.size
    # The logo is vertically centered. Assume y = height//2 - height//4 is safe background.
    sample_y = height // 4
    sample_x = width // 2
    return img.getpixel((sample_x, sample_y))

def homogenize_bg(in_path, out_path):
    img = Image.open(in_path).convert("RGB")
    width, height = img.size
    
    target_bg = get_base_bg(img)
    print(f"Detected target background color: {target_bg}")
    
    # We will determine the baseline luminance of the background
    bg_lum = 0.299 * target_bg[0] + 0.587 * target_bg[1] + 0.114 * target_bg[2]
    
    out = Image.new("RGB", (width, height), target_bg)
    in_data = img.load()
    out_data = out.load()
    
    # threshold for blending
    low_thresh = max(bg_lum + 10, 40)
    high_thresh = low_thresh + 60
    
    for y in range(height):
        for x in range(width):
            r, g, b = in_data[x, y]
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            
            if lum <= low_thresh:
                out_data[x, y] = target_bg
            else:
                if lum < high_thresh:
                    alpha = (lum - low_thresh) / (high_thresh - low_thresh)
                else:
                    alpha = 1.0
                
                nr = int(target_bg[0] * (1 - alpha) + r * alpha)
                ng = int(target_bg[1] * (1 - alpha) + g * alpha)
                nb = int(target_bg[2] * (1 - alpha) + b * alpha)
                out_data[x, y] = (nr, ng, nb)
                
    out.save(out_path)
    print(f"Saved {out_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python fix_bg.py <input> <output>")
        sys.exit(1)
    homogenize_bg(sys.argv[1], sys.argv[2])
